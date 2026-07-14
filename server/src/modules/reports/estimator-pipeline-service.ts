import { sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@trock-crm/shared/schema";
import {
  CANONICAL_DEAL_STAGE_SLUGS,
  CANONICAL_DEAL_STAGE_LABELS,
  ESTIMATOR_PIPELINE_TARGET_KEYS,
  toCanonicalDealStageSlug,
  type EstimatorAssignmentIssue,
  type EstimatorPipelineBucket,
  type EstimatorPipelineCohort,
  type EstimatorPipelineEvidenceRecord,
  type EstimatorPipelineEvidenceResponse,
  type EstimatorPipelineMetric,
  type EstimatorPipelineReport,
  type EstimatorPipelineStageSummary,
  type EstimatorPipelineTargetKey,
  type EstimatorPipelineWonPeriod,
  type WorkflowRoute,
} from "@trock-crm/shared/types";
import {
  aliasedActiveDealCountFilterSql,
  aliasedBidBoardTerminalSql,
  aliasedWonHsClosedWonDateSql,
} from "../shared/deal-value-sql.js";
import { WON_STAGE_SLUGS } from "../shared/pipeline-terminal-stages.js";
import { aliasedEffectiveStageAgeDaysSql } from "../deals/deal-filter-predicates.js";
import { getWtdPeriod } from "../../lib/period.js";
import { dealValueSqlForBasis } from "./foundations.js";

const { companies, deals, pipelineStageConfig, properties, users } = schema;
type TenantDb = NodePgDatabase<typeof schema>;

export const ESTIMATOR_PIPELINE_TARGETS: ReadonlyArray<{
  key: EstimatorPipelineTargetKey;
  configuredName: string;
  email: string;
}> = [
  { key: "sidney_gibson", configuredName: "Sidney Gibson", email: "sgibson@trockgc.com" },
  { key: "alex_koch", configuredName: "Alex Koch", email: "akoch@trockgc.com" },
];

const ACTIONABLE_MISSING_STAGE_SLUGS = new Set([
  "estimating",
  "service_estimating",
  "estimate_under_review",
  "estimate_sent_to_client",
  "contract",
]);

const UNASSIGNED_LEGACY_KEYS = new Set(["not assigned", "unassigned", "n/a", "na", "none", "tbd"]);
const openValueSql = () => dealValueSqlForBasis("d", "open_best_estimate");
const wonValueSql = () => dealValueSqlForBasis("d", "won_awarded_first");
const effectiveStageSql = () => sql`COALESCE(NULLIF(d.bid_board_stage_slug, ''), psc.slug)`;
const wonDateSql = () => aliasedWonHsClosedWonDateSql("d");
const wonStageSlugsSql = () => sql.join(WON_STAGE_SLUGS.map((slug) => sql`${slug}`), sql`, `);
const VALUE_BASIS_LABELS = {
  open: "Best current estimate",
  won: "Awarded-first won value",
} as const;

// This is a published-number contract, not a cosmetic version. Whenever the Won-YTD predicate, date basis,
// or value basis changes, update both values in the same PR. The database records the last measured contract
// and emits a release-cited outbox event if a new contract lowers the visible metric without any deal mutation.
const ESTIMATOR_WON_YTD_DEFINITION_VERSION = "2026-07-14-v1";
const ESTIMATOR_WON_YTD_DEFINITION_HASH = "estimator-won-ytd-v1";
const ESTIMATOR_WON_YTD_RELEASE_REFERENCE =
  "P0 remediation 2026-07-14: Estimator Pipeline Won YTD definition snapshot.";

function wonYtdPeriod(now: Date): EstimatorPipelineWonPeriod {
  const { from, to } = getWtdPeriod("ytd", now);
  return { from, to, label: "Won YTD" };
}

function wonYtdPeriodForEvidence(asOf: string | undefined, now: Date): EstimatorPipelineWonPeriod {
  if (!asOf) return wonYtdPeriod(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    throw new Error("Estimator pipeline evidence asOf must be an ISO date");
  }
  const anchor = new Date(`${asOf}T12:00:00.000Z`);
  if (Number.isNaN(anchor.getTime()) || anchor.toISOString().slice(0, 10) !== asOf) {
    throw new Error("Estimator pipeline evidence asOf must be a valid ISO date");
  }
  return wonYtdPeriod(anchor);
}

function cohortValueSql(cohort: EstimatorPipelineCohort): SQL {
  return cohort === "won" ? wonValueSql() : openValueSql();
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] })?.rows ?? []) as T[];
}

function num(value: unknown): number {
  return Number(value ?? 0);
}

function money(value: unknown): number {
  return Math.round(num(value) * 100) / 100;
}

function addMoney(left: number, right: number): number {
  return (Math.round(left * 100) + Math.round(right * 100)) / 100;
}

function emptyMetric(): EstimatorPipelineMetric {
  return { count: 0, value: 0 };
}

function addMetric(target: EstimatorPipelineMetric, count: number, value: number): void {
  target.count += count;
  target.value = addMoney(target.value, value);
}

function isMissingDefinitionTracker(error: unknown): boolean {
  const candidate = error as { code?: unknown; cause?: { code?: unknown } } | null;
  // Drizzle wraps PostgreSQL errors in some runtime paths; only the explicit PostgreSQL undefined-
  // function code is a safe compatibility case during migration rollout.
  return candidate?.code === "42883" || candidate?.cause?.code === "42883";
}

/**
 * Persist the current result under its explicit metric-definition contract. The migration may be rolled out
 * independently of the API during a deploy, so a missing function is deliberately treated as a no-op only
 * for that narrow compatibility window. Any other database error must still fail the request/transaction.
 */
async function recordEstimatorWonYtdDefinition(
  tenantDb: TenantDb,
  won: EstimatorPipelineMetric,
): Promise<void> {
  try {
    await tenantDb.execute(sql`
      SELECT public.record_won_metric_definition_snapshot(
        current_schema()::text,
        ${"estimator_pipeline.won_ytd"},
        ${ESTIMATOR_WON_YTD_DEFINITION_VERSION},
        ${ESTIMATOR_WON_YTD_DEFINITION_HASH},
        ${won.count},
        ${won.value},
        ${ESTIMATOR_WON_YTD_RELEASE_REFERENCE}
      )
    `);
  } catch (error) {
    if (isMissingDefinitionTracker(error)) return;
    throw error;
  }
}

/**
 * The overview and evidence queries share one canonical base-project scope.
 * The tenant itself is selected by req.tenantDb/X-Office-ID; never filter on the estimator's home office.
 */
export function estimatorPipelineScopeSql(
  cohort: EstimatorPipelineCohort = "open",
  period?: EstimatorPipelineWonPeriod,
): SQL {
  const baseScope = sql`
    d.is_active = true
    AND COALESCE(d.is_test_data, false) = false
    AND COALESCE(d.is_change_order, false) = false
    AND ${aliasedActiveDealCountFilterSql("d")}
  `;
  if (cohort === "open") {
    return sql`${baseScope}
      AND psc.is_terminal = false
      AND NOT ${aliasedBidBoardTerminalSql("d")}`;
  }
  if (!period) throw new Error("Won estimator pipeline scope requires a YTD period");
  return sql`${baseScope}
    AND ${effectiveStageSql()} IN (${wonStageSlugsSql()})
    AND ${wonDateSql()} IS NOT NULL
    AND ${wonDateSql()} >= ${period.from}::date
    AND ${wonDateSql()} <= ${period.to}::date`;
}

export function buildEstimatorTargetUsersSql(): SQL {
  return sql`
    SELECT u.id AS id,
           u.email AS email,
           u.display_name AS display_name,
           u.is_active AS is_active
    FROM ${users} u
    WHERE LOWER(u.email) IN (${sql.join(
      ESTIMATOR_PIPELINE_TARGETS.map((target) => sql`${target.email.toLowerCase()}`),
      sql`, `
    )})
    ORDER BY u.display_name ASC
  `;
}

export function buildEstimatorPipelineSummarySql(
  cohort: EstimatorPipelineCohort = "open",
  period?: EstimatorPipelineWonPeriod,
): SQL {
  return sql`
    SELECT d.estimator_user_id AS estimator_user_id,
           ${effectiveStageSql()} AS stage_slug,
           d.workflow_route AS workflow_route,
           MIN(psc.name) AS stage_label,
           MIN(psc.display_order)::int AS display_order,
           COUNT(*)::int AS project_count,
           COALESCE(SUM(${cohortValueSql(cohort)}), 0)::numeric AS pipeline_value
    FROM ${deals} d
    JOIN ${pipelineStageConfig} psc ON psc.id = d.stage_id
    WHERE ${estimatorPipelineScopeSql(cohort, period)}
    GROUP BY d.estimator_user_id, ${effectiveStageSql()}, d.workflow_route
    ORDER BY MIN(psc.display_order) ASC, MIN(psc.name) ASC
  `;
}

interface TargetUserRow {
  id: string;
  email: string;
  display_name: string;
  is_active: boolean;
}

interface ResolvedTarget {
  key: EstimatorPipelineTargetKey;
  configuredName: string;
  userId: string | null;
  name: string;
  resolved: boolean;
  active: boolean | null;
}

async function resolveTargets(tenantDb: TenantDb): Promise<ResolvedTarget[]> {
  const rows = rowsFromExecute<TargetUserRow>(await tenantDb.execute(buildEstimatorTargetUsersSql()));
  const byEmail = new Map(rows.map((row) => [row.email.trim().toLowerCase(), row]));
  return ESTIMATOR_PIPELINE_TARGETS.map((target) => {
    const row = byEmail.get(target.email.toLowerCase());
    return {
      key: target.key,
      configuredName: target.configuredName,
      userId: row?.id ?? null,
      name: row?.display_name?.trim() || target.configuredName,
      resolved: Boolean(row),
      active: row ? Boolean(row.is_active) : null,
    };
  });
}

interface SummaryRow {
  estimator_user_id: string | null;
  stage_slug: string;
  workflow_route: WorkflowRoute;
  stage_label: string;
  display_order: unknown;
  project_count: unknown;
  pipeline_value: unknown;
}

interface CanonicalStage {
  stageSlug: string;
  stageLabel: string;
  displayOrder: number;
}

const canonicalStageLabels = CANONICAL_DEAL_STAGE_LABELS as Record<string, string>;

export function canonicalizeEstimatorPipelineStage(input: {
  stageSlug: string;
  stageLabel: string;
  workflowRoute: WorkflowRoute;
  displayOrder: number;
}): CanonicalStage {
  const canonicalSlug = toCanonicalDealStageSlug(input.stageSlug, input.workflowRoute) ?? input.stageSlug;
  const canonicalIndex = (CANONICAL_DEAL_STAGE_SLUGS as readonly string[]).indexOf(canonicalSlug);
  return {
    stageSlug: canonicalSlug,
    stageLabel: canonicalStageLabels[canonicalSlug] ?? (input.stageLabel || canonicalSlug),
    // Bid Board-owned projects can retain an Opportunity CRM stage while their mirror is already estimating.
    // The CRM stage's display order is therefore not a safe order for the effective stage shown here.
    displayOrder: canonicalIndex >= 0 ? (canonicalIndex + 1) * 10 : input.displayOrder,
  };
}

function mergeStage(
  target: Map<string, EstimatorPipelineStageSummary>,
  stage: CanonicalStage,
  count: number,
  value: number,
): void {
  const current = target.get(stage.stageSlug);
  if (current) {
    current.count += count;
    current.value = addMoney(current.value, value);
    current.displayOrder = Math.min(current.displayOrder, stage.displayOrder);
    return;
  }
  target.set(stage.stageSlug, { ...stage, count, value });
}

function sortedStages(map: Map<string, EstimatorPipelineStageSummary>): EstimatorPipelineStageSummary[] {
  return [...map.values()].sort(
    (a, b) => a.displayOrder - b.displayOrder || a.stageLabel.localeCompare(b.stageLabel),
  );
}

export async function getEstimatorPipelineReport(
  tenantDb: TenantDb,
  now: Date = new Date(),
): Promise<EstimatorPipelineReport> {
  const wonPeriod = wonYtdPeriod(now);
  // tenantDb is a single transaction-bound pg client. Run these in sequence so later queries do not spend
  // their query_timeout budget waiting behind earlier work in the same client queue.
  const targets = await resolveTargets(tenantDb);
  const rawRows = rowsFromExecute<SummaryRow>(await tenantDb.execute(buildEstimatorPipelineSummarySql()));
  const rawWonRows = rowsFromExecute<SummaryRow>(
    await tenantDb.execute(buildEstimatorPipelineSummarySql("won", wonPeriod)),
  );

  const targetById = new Map(
    targets.flatMap((target) => (target.userId ? [[target.userId, target.key] as const] : [])),
  );
  const targetMetrics = new Map(
    ESTIMATOR_PIPELINE_TARGET_KEYS.map((key) => [
      key,
      { ...emptyMetric(), won: emptyMetric(), stages: new Map<string, EstimatorPipelineStageSummary>() },
    ]),
  );
  const pipeline = emptyMetric();
  const won = emptyMetric();
  const otherAssigned = {
    ...emptyMetric(),
    won: emptyMetric(),
    stages: new Map<string, EstimatorPipelineStageSummary>(),
  };
  const missingEstimator = {
    ...emptyMetric(),
    actionableCount: 0,
    actionableValue: 0,
    won: emptyMetric(),
    stages: new Map<string, EstimatorPipelineStageSummary>(),
  };
  const stageColumns = new Map<string, EstimatorPipelineStageSummary>();

  for (const row of rawRows) {
    const count = num(row.project_count);
    const value = money(row.pipeline_value);
    const stage = canonicalizeEstimatorPipelineStage({
      stageSlug: String(row.stage_slug),
      stageLabel: String(row.stage_label || row.stage_slug),
      workflowRoute: row.workflow_route === "service" ? "service" : "normal",
      displayOrder: num(row.display_order),
    });

    addMetric(pipeline, count, value);
    mergeStage(stageColumns, stage, count, value);

    if (row.estimator_user_id == null) {
      addMetric(missingEstimator, count, value);
      mergeStage(missingEstimator.stages, stage, count, value);
      if (ACTIONABLE_MISSING_STAGE_SLUGS.has(stage.stageSlug)) {
        missingEstimator.actionableCount += count;
        missingEstimator.actionableValue = addMoney(missingEstimator.actionableValue, value);
      }
      continue;
    }

    const targetKey = targetById.get(String(row.estimator_user_id));
    if (targetKey) {
      const metric = targetMetrics.get(targetKey)!;
      addMetric(metric, count, value);
      mergeStage(metric.stages, stage, count, value);
      continue;
    }

    addMetric(otherAssigned, count, value);
    mergeStage(otherAssigned.stages, stage, count, value);
  }

  for (const row of rawWonRows) {
    const count = num(row.project_count);
    const value = money(row.pipeline_value);
    addMetric(won, count, value);

    if (row.estimator_user_id == null) {
      addMetric(missingEstimator.won, count, value);
      continue;
    }

    const targetKey = targetById.get(String(row.estimator_user_id));
    if (targetKey) {
      addMetric(targetMetrics.get(targetKey)!.won, count, value);
      continue;
    }

    addMetric(otherAssigned.won, count, value);
  }

  const warnings: string[] = [];
  for (const target of targets) {
    if (!target.resolved) {
      warnings.push(`${target.configuredName} could not be resolved to a CRM user. Check the report identity configuration.`);
    } else if (!target.active) {
      warnings.push(`${target.name} is inactive. Existing assignments remain visible and may need reassignment.`);
    }
  }

  // Keep this after the complete Won aggregation: it records exactly the number this response will publish.
  // The tracker is transaction-safe and emits an outbox job only when a newly-versioned definition lowers it.
  await recordEstimatorWonYtdDefinition(tenantDb, won);

  return {
    generatedAt: now.toISOString(),
    scope: {
      kind: "active_office",
      cohort: "current_open_pipeline_plus_won_ytd",
      note: "Current open base projects plus year-to-date Won base projects in the selected office. Test, held, change-order, Lost, and soft-deleted projects are excluded.",
    },
    // Keep the original field during the additive API rollout so already-open clients remain compatible.
    valueBasisLabel: VALUE_BASIS_LABELS.open,
    valueBasisLabels: VALUE_BASIS_LABELS,
    pipeline,
    won,
    wonPeriod,
    stageColumns: sortedStages(stageColumns).map(({ stageSlug, stageLabel, displayOrder }) => ({
      stageSlug,
      stageLabel,
      displayOrder,
    })),
    estimators: targets.map((target) => {
      const metric = targetMetrics.get(target.key)!;
      return {
        key: target.key,
        configuredName: target.configuredName,
        estimatorUserId: target.userId,
        estimatorName: target.name,
        resolved: target.resolved,
        active: target.active,
        count: metric.count,
        value: metric.value,
        won: metric.won,
        stages: sortedStages(metric.stages),
      };
    }),
    otherAssigned: {
      count: otherAssigned.count,
      value: otherAssigned.value,
      won: otherAssigned.won,
      stages: sortedStages(otherAssigned.stages),
    },
    missingEstimator: {
      count: missingEstimator.count,
      value: missingEstimator.value,
      actionableCount: missingEstimator.actionableCount,
      actionableValue: missingEstimator.actionableValue,
      won: missingEstimator.won,
      stages: sortedStages(missingEstimator.stages),
    },
    warnings,
  };
}

function targetIdFilterSql(targetIds: string[]): SQL {
  if (targetIds.length === 0) return sql`TRUE`;
  return sql`d.estimator_user_id NOT IN (${sql.join(targetIds.map((id) => sql`${id}::uuid`), sql`, `)})`;
}

export function buildEstimatorPipelineEvidenceSql(input: {
  cohort?: EstimatorPipelineCohort;
  period?: EstimatorPipelineWonPeriod;
  bucket: EstimatorPipelineBucket;
  estimatorUserId?: string | null;
  targetEstimatorIds?: string[];
}): SQL {
  const cohort = input.cohort ?? "open";
  const bucketFilter =
    input.bucket === "missing"
      ? sql`d.estimator_user_id IS NULL`
      : input.bucket === "target"
        ? sql`d.estimator_user_id = ${input.estimatorUserId ?? "00000000-0000-0000-0000-000000000000"}::uuid`
        : sql`d.estimator_user_id IS NOT NULL AND ${targetIdFilterSql(input.targetEstimatorIds ?? [])}`;

  return sql`
    SELECT d.id AS deal_id,
           d.deal_number AS deal_number,
           d.project_number AS project_number,
           d.name AS deal_name,
           d.assigned_rep_id AS owner_id,
           COALESCE(owner_user.display_name, '') AS owner_name,
           c.name AS company_name,
           p.name AS property_name,
           ${effectiveStageSql()} AS stage_slug,
           psc.name AS stage_label,
           psc.display_order::int AS display_order,
           d.workflow_route AS workflow_route,
           ${aliasedEffectiveStageAgeDaysSql("d")}::int AS days_in_stage,
           COALESCE(${cohortValueSql(cohort)}, 0)::numeric AS pipeline_value,
           d.expected_close_date AS expected_close_date,
           d.won_closed_date AS won_closed_date,
           d.estimator_user_id AS estimator_user_id,
           estimator_user.display_name AS estimator_name,
           estimator_user.is_active AS estimator_active,
           COALESCE(NULLIF(BTRIM(d.bid_board_estimator), ''), NULLIF(BTRIM(d.estimator), '')) AS legacy_estimator_name,
           d.is_bid_board_owned AS is_bid_board_owned
    FROM ${deals} d
    JOIN ${pipelineStageConfig} psc ON psc.id = d.stage_id
    LEFT JOIN ${users} owner_user ON owner_user.id = d.assigned_rep_id
    LEFT JOIN ${users} estimator_user ON estimator_user.id = d.estimator_user_id
    LEFT JOIN ${companies} c ON c.id = d.company_id
    LEFT JOIN ${properties} p ON p.id = d.property_id
    WHERE ${estimatorPipelineScopeSql(cohort, input.period)}
      AND ${bucketFilter}
    ORDER BY psc.display_order ASC, pipeline_value DESC, d.name ASC
  `;
}

interface EvidenceRow {
  deal_id: string;
  deal_number: string | null;
  project_number: string | null;
  deal_name: string;
  owner_id: string | null;
  owner_name: string;
  company_name: string | null;
  property_name: string | null;
  stage_slug: string;
  stage_label: string;
  display_order: unknown;
  workflow_route: WorkflowRoute;
  days_in_stage: unknown;
  pipeline_value: unknown;
  expected_close_date: unknown;
  won_closed_date: unknown;
  estimator_user_id: string | null;
  estimator_name: string | null;
  estimator_active: boolean | null;
  legacy_estimator_name: string | null;
  is_bid_board_owned: boolean;
}

function assignmentIssue(row: EvidenceRow): EstimatorAssignmentIssue {
  if (row.estimator_user_id != null) {
    return row.estimator_active === false ? "inactive_estimator" : "none";
  }
  const legacyKey = row.legacy_estimator_name?.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase() ?? "";
  return legacyKey && !UNASSIGNED_LEGACY_KEYS.has(legacyKey) ? "unmapped_legacy" : "unassigned";
}

function mapEvidenceRow(row: EvidenceRow): EstimatorPipelineEvidenceRecord {
  const workflowRoute: WorkflowRoute = row.workflow_route === "service" ? "service" : "normal";
  const stage = canonicalizeEstimatorPipelineStage({
    stageSlug: String(row.stage_slug),
    stageLabel: String(row.stage_label || row.stage_slug),
    workflowRoute,
    displayOrder: num(row.display_order),
  });
  return {
    dealId: String(row.deal_id),
    dealNumber: row.deal_number == null ? null : String(row.deal_number),
    projectNumber: row.project_number == null ? null : String(row.project_number),
    dealName: String(row.deal_name),
    ownerId: row.owner_id == null ? null : String(row.owner_id),
    ownerName: row.owner_name?.trim() || "Unassigned",
    companyName: row.company_name == null ? null : String(row.company_name),
    propertyName: row.property_name == null ? null : String(row.property_name),
    ...stage,
    workflowRoute,
    daysInStage: row.days_in_stage == null ? null : num(row.days_in_stage),
    pipelineValue: money(row.pipeline_value),
    expectedCloseDate: row.expected_close_date == null ? null : String(row.expected_close_date).slice(0, 10),
    wonClosedDate: row.won_closed_date == null ? null : String(row.won_closed_date).slice(0, 10),
    estimatorUserId: row.estimator_user_id == null ? null : String(row.estimator_user_id),
    estimatorName: row.estimator_name == null ? null : String(row.estimator_name),
    estimatorActive: row.estimator_active == null ? null : Boolean(row.estimator_active),
    legacyEstimatorName: row.legacy_estimator_name == null ? null : String(row.legacy_estimator_name),
    assignmentIssue: assignmentIssue(row),
    isBidBoardOwned: Boolean(row.is_bid_board_owned),
  };
}

export interface EstimatorPipelineEvidenceOptions {
  cohort?: EstimatorPipelineCohort;
  asOf?: string;
  bucket: EstimatorPipelineBucket;
  estimatorKey?: EstimatorPipelineTargetKey;
  stageSlug?: string;
  page?: number;
  pageSize?: number;
  now?: Date;
}

export async function getEstimatorPipelineEvidence(
  tenantDb: TenantDb,
  options: EstimatorPipelineEvidenceOptions,
): Promise<EstimatorPipelineEvidenceResponse> {
  const now = options.now ?? new Date();
  const cohort = options.cohort ?? "open";
  const period = cohort === "won" ? wonYtdPeriodForEvidence(options.asOf, now) : null;
  const targets = await resolveTargets(tenantDb);
  const selectedTarget = options.estimatorKey
    ? targets.find((target) => target.key === options.estimatorKey) ?? null
    : null;
  const targetIds = targets.flatMap((target) => (target.userId ? [target.userId] : []));

  if (options.bucket === "target" && !selectedTarget) {
    throw new Error("A configured estimatorKey is required for target evidence");
  }

  const rows =
    options.bucket === "target" && !selectedTarget?.userId
      ? []
      : rowsFromExecute<EvidenceRow>(
          await tenantDb.execute(
            buildEstimatorPipelineEvidenceSql({
              cohort,
              period: period ?? undefined,
              bucket: options.bucket,
              estimatorUserId: selectedTarget?.userId,
              targetEstimatorIds: targetIds,
            }),
          ),
        );

  let records = rows.map(mapEvidenceRow);
  if (options.stageSlug) {
    records = records.filter((record) => record.stageSlug === options.stageSlug);
  }
  records.sort(
    (a, b) =>
      a.displayOrder - b.displayOrder ||
      b.pipelineValue - a.pipelineValue ||
      a.dealName.localeCompare(b.dealName),
  );

  const total = records.reduce<EstimatorPipelineMetric>((sum, record) => {
    addMetric(sum, 1, record.pipelineValue);
    return sum;
  }, emptyMetric());
  const pageSize = Math.min(100, Math.max(1, Math.trunc(options.pageSize ?? 25)));
  const totalPages = Math.max(1, Math.ceil(total.count / pageSize));
  const page = Math.min(totalPages, Math.max(1, Math.trunc(options.page ?? 1)));
  const start = (page - 1) * pageSize;
  const pageRecords = records.slice(start, start + pageSize);
  const stageLabel = options.stageSlug
    ? pageRecords[0]?.stageLabel ?? canonicalStageLabels[options.stageSlug] ?? options.stageSlug
    : null;

  return {
    generatedAt: now.toISOString(),
    filter: {
      cohort,
      bucket: options.bucket,
      estimatorKey: selectedTarget?.key ?? null,
      estimatorName: selectedTarget?.name ?? null,
      stageSlug: options.stageSlug ?? null,
      stageLabel,
      valueBasisLabel: VALUE_BASIS_LABELS[cohort],
      period,
    },
    total,
    pagination: { page, pageSize, total: total.count, totalPages },
    records: pageRecords,
  };
}
