import { eq, and, sql, gte, lte, inArray, asc } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  auditLog,
  aiDisconnectCases,
  deals,
  dealSignedCommissions,
  leads,
  duplicateQueue,
  jobQueue,
  procoreSyncState,
  tasks,
  users,
  userCommissionSettings,
  pipelineStageConfig,
  companies,
  properties,
} from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import {
  CANONICAL_DEAL_STAGE_LABELS,
  DEFAULT_ACTIVITY_RANGE,
  getDealAtRiskResult,
  USER_ROLES,
  type AtRiskResult,
  type ActivityRange,
  type UserRole,
  type WorkflowRoute,
} from "@trock-crm/shared/types";
import { db } from "../../db.js";
import { TERMINAL_STAGE_SLUGS } from "../shared/pipeline-terminal-stages.js";
import {
  getPipelineSummary,
  getWinRateTrend,
  getActivitySummaryByRep,
  getFollowUpCompliance,
  getDdVsPipeline,
  getWinLossRatioByRep,
  type PipelineSummaryRow,
  type StaleDealRow,
} from "../reports/service.js";
import { getMyCleanupQueue } from "../admin/cleanup-queue-service.js";
import { getMigrationSummary } from "../migration/service.js";
import {
  buildAliasedDealMineVisibilityCondition,
  buildAliasedLeadMineVisibilityCondition,
  resolveMineVisibilityFeatures,
} from "../shared/mine-visibility.js";
import {
  aliasedActiveDealCountFilterSql,
  aliasedEffectiveAwardedDealValueSql,
  aliasedEffectiveDealValueSql,
} from "../shared/deal-value-sql.js";

type TenantDb = NodePgDatabase<typeof schema>;
type ExecuteRows<T> = { rows: T[] } | T[];
export type DashboardAtRiskSummaryRow = {
  dealId?: string | null;
  dealNumber?: string | null;
  stageId?: string | null;
  repId?: string | null;
  repName?: string | null;
  dealName?: string | null;
  stageName?: string | null;
  regionClassification?: string | null;
  dealValue: number;
  stageSlug: string | null;
  mirroredStageStatus?: string | null;
  workflowRoute?: WorkflowRoute | null;
  stageEnteredAt?: string | Date | null;
  onHold?: boolean | null;
  onHoldStartedAt?: string | Date | null;
  onHoldAccumulatedSeconds?: number | string | bigint | null;
  onHoldAccumulatedSecondsAtStageEntry?: number | string | bigint | null;
};

type DashboardAtRiskEvaluation = {
  row: DashboardAtRiskSummaryRow;
  atRisk: AtRiskResult;
};

function rowsFromExecute<T>(result: ExecuteRows<T>): T[] {
  return Array.isArray(result) ? result : result.rows;
}

function sqlSlugList(values: readonly string[]) {
  return sql.join(values.map((value) => sql`${value}`), sql`, `);
}

function nonTerminalDealStageSql() {
  return sql`
    psc.is_terminal = false
    AND COALESCE(d.bid_board_stage_slug, psc.slug) NOT IN (${sqlSlugList(TERMINAL_STAGE_SLUGS)})
  `;
}

function normalizeAtRiskViewerRole(role: string | null | undefined): UserRole | null {
  return USER_ROLES.includes(role as UserRole) ? (role as UserRole) : null;
}

export function buildDashboardAtRiskSummary(
  rows: DashboardAtRiskSummaryRow[],
  viewerRole: string | null | undefined,
  now: Date = new Date()
): { count: number; totalValue: number } {
  return buildDashboardAtRiskEvaluations(rows, viewerRole, now).reduce(
    (acc, row) => {
      if (!row.atRisk.isAtRisk) return acc;
      return {
        count: acc.count + 1,
        totalValue: acc.totalValue + Number(row.row.dealValue ?? 0),
      };
    },
    { count: 0, totalValue: 0 }
  );
}

function buildDashboardAtRiskEvaluations(
  rows: DashboardAtRiskSummaryRow[],
  viewerRole: string | null | undefined,
  now: Date = new Date()
): DashboardAtRiskEvaluation[] {
  const normalizedViewerRole = normalizeAtRiskViewerRole(viewerRole);
  return rows.map((row) => ({
    row,
    atRisk: getDealAtRiskResult(
      {
        stageSlug: row.stageSlug,
        workflowRoute: row.workflowRoute ?? "normal",
        stageEnteredAt: row.stageEnteredAt ?? null,
        onHold: row.onHold,
        onHoldStartedAt: row.onHoldStartedAt,
        onHoldAccumulatedSeconds:
          row.onHoldAccumulatedSeconds == null ? null : Number(row.onHoldAccumulatedSeconds),
        onHoldAccumulatedSecondsAtStageEntry:
          row.onHoldAccumulatedSecondsAtStageEntry == null
            ? null
            : Number(row.onHoldAccumulatedSecondsAtStageEntry),
      },
      normalizedViewerRole,
      now
    ),
  }));
}

const LEAD_STALE_ENGINE_STAGE_SLUG = "opportunity";
const LEAD_STALE_VIEWER_ROLE: UserRole = "rep";

function getLeadStaleAtRiskResult(
  stageEnteredAt: string | Date | null | undefined,
  workflowRoute: string | null | undefined,
  now: Date
): AtRiskResult {
  return getDealAtRiskResult(
    {
      stageSlug: LEAD_STALE_ENGINE_STAGE_SLUG,
      workflowRoute: workflowRoute === "service" ? "service" : "normal",
      stageEnteredAt,
    },
    LEAD_STALE_VIEWER_ROLE,
    now
  );
}

export function buildDashboardAtRiskDeals(
  rows: DashboardAtRiskSummaryRow[],
  viewerRole: string | null | undefined,
  now: Date = new Date()
): DashboardAtRiskDealRow[] {
  const atRiskDeals: DashboardAtRiskDealRow[] = [];

  for (const { row, atRisk } of buildDashboardAtRiskEvaluations(rows, viewerRole, now)) {
    if (!atRisk.isAtRisk) continue;

    atRiskDeals.push({
      dealId: String(row.dealId ?? ""),
      repId: row.repId ? String(row.repId) : null,
      repName: String(row.repName ?? "Unassigned"),
      dealName: String(row.dealName ?? "Deal"),
      stageName: resolveMirroredStageLabel(row.stageSlug, row.stageName ?? "Stage"),
      mirroredStageStatus: row.mirroredStageStatus ?? null,
      workflowRoute: row.workflowRoute === "service" ? "service" : "normal",
      regionClassification: String(row.regionClassification ?? "Unassigned region"),
      dealValue: Number(row.dealValue ?? 0),
      daysInStage: atRisk.effectiveStageAgeDays,
      staleThresholdDays: atRisk.thresholdDays ?? 0,
      atRisk,
    });
  }

  return atRiskDeals;
}

export function buildDashboardAtRiskStaleDeals(
  rows: DashboardAtRiskSummaryRow[],
  viewerRole: string | null | undefined,
  now: Date = new Date()
): StaleDealRow[] {
  return buildDashboardAtRiskEvaluations(rows, viewerRole, now)
    .filter(({ atRisk }) => atRisk.isAtRisk)
    .sort((a, b) => {
      if (b.atRisk.effectiveStageAgeDays !== a.atRisk.effectiveStageAgeDays) {
        return b.atRisk.effectiveStageAgeDays - a.atRisk.effectiveStageAgeDays;
      }
      return String(a.row.dealName ?? "").localeCompare(String(b.row.dealName ?? ""));
    })
    .map(({ row, atRisk }) => ({
      dealId: String(row.dealId ?? ""),
      dealNumber: String(row.dealNumber ?? ""),
      dealName: String(row.dealName ?? "Deal"),
      stageId: String(row.stageId ?? ""),
      stageName: resolveMirroredStageLabel(row.stageSlug, row.stageName ?? "Stage"),
      assignedRepId: String(row.repId ?? ""),
      repName: String(row.repName ?? "Unassigned"),
      stageEnteredAt: row.stageEnteredAt ? String(row.stageEnteredAt) : "",
      daysInStage: atRisk.effectiveStageAgeDays,
      staleThresholdDays: atRisk.thresholdDays ?? 0,
      dealValue: Number(row.dealValue ?? 0),
      workflowRoute: row.workflowRoute === "service" ? "service" : "normal",
      bidBoardStageSlug: row.stageSlug ?? null,
      bidBoardStageStatus: row.mirroredStageStatus ?? null,
      regionClassification: row.regionClassification ?? null,
    }));
}

export function buildDashboardDownstreamBottlenecks(
  rows: DashboardAtRiskSummaryRow[],
  viewerRole: string | null | undefined,
  now: Date = new Date()
): DashboardDownstreamBottleneckRow[] {
  return buildDashboardAtRiskEvaluations(rows, viewerRole, now)
    .filter(
      ({ row, atRisk }) =>
        atRisk.isAtRisk &&
        atRisk.canonicalStageSlug != null &&
        (MIRRORED_DOWNSTREAM_STAGE_SLUGS as readonly string[]).includes(
          atRisk.canonicalStageSlug
        )
    )
    .sort((a, b) => {
      const pastDelta = (b.atRisk.secondsPastThreshold ?? 0) - (a.atRisk.secondsPastThreshold ?? 0);
      if (pastDelta !== 0) return pastDelta;
      const valueDelta = Number(b.row.dealValue ?? 0) - Number(a.row.dealValue ?? 0);
      if (valueDelta !== 0) return valueDelta;
      return String(a.row.dealName ?? "").localeCompare(String(b.row.dealName ?? ""));
    })
    .slice(0, 8)
    .map(({ row, atRisk }) => ({
      dealId: String(row.dealId ?? ""),
      repId: row.repId ? String(row.repId) : null,
      repName: String(row.repName ?? "Unassigned"),
      dealName: String(row.dealName ?? "Deal"),
      stageName: resolveMirroredStageLabel(row.stageSlug, row.stageName ?? "Stage"),
      mirroredStageStatus: row.mirroredStageStatus ?? null,
      workflowRoute: row.workflowRoute === "service" ? "service" : "normal",
      regionClassification: String(row.regionClassification ?? "Unassigned region"),
      dealValue: Number(row.dealValue ?? 0),
      daysInStage: atRisk.effectiveStageAgeDays,
      staleThresholdDays: atRisk.thresholdDays ?? 0,
      atRisk,
    }));
}

type DashboardScopeOptions = {
  repId?: string;
  viewerUserId?: string;
  viewerRole?: string;
  includeDealSubscriptions?: boolean;
  includeLeadSubscriptions?: boolean;
  includeDealCreatedBy?: boolean;
  includeLeadCreatedBy?: boolean;
  includeDealSubscriptionDeletedAt?: boolean;
  includeLeadSubscriptionDeletedAt?: boolean;
};

function leadScopeFilterSql(alias: string, options: DashboardScopeOptions) {
  if (options.viewerUserId) {
    return sql`AND ${buildAliasedLeadMineVisibilityCondition(alias, options.viewerUserId, {
      includeSubscriptions: options.includeLeadSubscriptions,
      includeCreatedBy: options.includeLeadCreatedBy,
      includeSubscriptionDeletedAt: options.includeLeadSubscriptionDeletedAt,
    })}`;
  }
  if (options.repId) {
    return sql`AND ${sql.raw(alias)}.assigned_rep_id = ${options.repId}`;
  }
  return sql``;
}

function dealScopeFilterSql(alias: string, options: DashboardScopeOptions) {
  if (options.viewerUserId) {
    return sql`AND ${buildAliasedDealMineVisibilityCondition(alias, options.viewerUserId, {
      includeSubscriptions: options.includeDealSubscriptions,
      includeCreatedBy: options.includeDealCreatedBy,
      includeSubscriptionDeletedAt: options.includeDealSubscriptionDeletedAt,
    })}`;
  }
  if (options.repId) {
    return sql`AND ${sql.raw(alias)}.assigned_rep_id = ${options.repId}`;
  }
  return sql``;
}
// Intentionally includes canonical stage-v2 slugs plus historical aliases so
// dashboard counts stay accurate while legacy rows still exist during rollout.
const ESTIMATING_PROGRESS_STAGE_SLUGS = [
  "estimating",
  "service_estimating",
  "estimate_under_review",
  "estimate_sent_to_client",
  "contract",
  "estimate_in_progress",
  "service_estimate_under_review",
  "service_estimate_sent_to_client",
] as const;
const COMMISSION_PIPELINE_STAGE_SLUGS = ["opportunity", ...ESTIMATING_PROGRESS_STAGE_SLUGS] as const;
const WON_STAGE_SLUGS = ["won"] as const;
const LOST_STAGE_SLUGS = ["lost"] as const;
const LEGACY_WON_STAGE_SLUGS = ["sent_to_production", "service_sent_to_production", "closed_won"] as const;
const LEGACY_LOST_STAGE_SLUGS = ["production_lost", "service_lost", "closed_lost"] as const;
const MIRRORED_DOWNSTREAM_STAGE_SLUGS = ESTIMATING_PROGRESS_STAGE_SLUGS;
const MIRRORED_DOWNSTREAM_STAGE_LABELS: Record<(typeof MIRRORED_DOWNSTREAM_STAGE_SLUGS)[number], string> = {
  estimating: "Estimating",
  service_estimating: "Service Estimating",
  estimate_under_review: "Estimate Under Review",
  estimate_sent_to_client: "Estimate Sent to Client",
  contract: "Contract",
  estimate_in_progress: "Estimate in Progress",
  service_estimate_under_review: "Service Estimate Under Review",
  service_estimate_sent_to_client: "Service Estimate Sent to Client",
};

function resolveMirroredStageLabel(
  mirroredStageSlug: string | null | undefined,
  fallbackStageName: string | null | undefined
) {
  if (
    mirroredStageSlug &&
    mirroredStageSlug in MIRRORED_DOWNSTREAM_STAGE_LABELS
  ) {
    return MIRRORED_DOWNSTREAM_STAGE_LABELS[
      mirroredStageSlug as keyof typeof MIRRORED_DOWNSTREAM_STAGE_LABELS
    ];
  }

  return fallbackStageName ?? "Unknown";
}

const NEW_LEAD_BOARD_STAGE_SLUGS = [
  "contacted",
  "lead_new",
  "company_pre_qualified",
  "scoping_in_progress",
  "new_lead",
] as const;

const QUALIFIED_LEAD_BOARD_STAGE_SLUGS = [
  "qualified_lead",
  "pre_qual_value_assigned",
  "director_go_no_go",
] as const;

const SALES_VALIDATION_BOARD_STAGE_SLUGS = [
  "lead_go_no_go",
  "qualified_for_opportunity",
  "ready_for_opportunity",
  "sales_validation_stage",
] as const;

function resolveLeadSnapshotStageLabel(stageSlug: string | null | undefined, fallbackStageName: string | null | undefined) {
  if (!stageSlug) {
    return fallbackStageName ?? "Unknown";
  }

  if (NEW_LEAD_BOARD_STAGE_SLUGS.includes(stageSlug as (typeof NEW_LEAD_BOARD_STAGE_SLUGS)[number])) {
    return "New Lead";
  }

  if (QUALIFIED_LEAD_BOARD_STAGE_SLUGS.includes(stageSlug as (typeof QUALIFIED_LEAD_BOARD_STAGE_SLUGS)[number])) {
    return "Qualified Lead";
  }

  if (
    SALES_VALIDATION_BOARD_STAGE_SLUGS.includes(
      stageSlug as (typeof SALES_VALIDATION_BOARD_STAGE_SLUGS)[number]
    )
  ) {
    return "Sales Validation Stage";
  }

  return fallbackStageName ?? "Unknown";
}

const LEGACY_NORMAL_DASHBOARD_STAGE_SLUGS = {
  dd: "opportunity",
  due_diligence: "opportunity",
  estimating: "estimating",
  estimate_in_progress: "estimating",
  bid_sent: "estimate_sent_to_client",
  in_production: "won",
  close_out: "won",
  closed_won: "won",
  closed_lost: "lost",
  sent_to_production: "won",
  service_sent_to_production: "won",
  production_lost: "lost",
  service_lost: "lost",
} as const;

const LEGACY_SERVICE_DASHBOARD_STAGE_SLUGS = {
  dd: "opportunity",
  due_diligence: "opportunity",
  estimating: "service_estimating",
  estimate_in_progress: "service_estimating",
  bid_sent: "estimate_sent_to_client",
  in_production: "won",
  close_out: "won",
  closed_won: "won",
  closed_lost: "lost",
  service_proposal_sent: "estimate_sent_to_client",
  service_scheduled: "won",
  service_complete: "won",
  sent_to_production: "won",
  service_sent_to_production: "won",
  production_lost: "lost",
  service_lost: "lost",
} as const;

function resolveCanonicalDealStageSlug(
  workflowRoute: WorkflowRoute,
  stageSlug: string | null | undefined
): keyof typeof CANONICAL_DEAL_STAGE_LABELS | null {
  if (!stageSlug) {
    return null;
  }

  if (stageSlug in CANONICAL_DEAL_STAGE_LABELS) {
    return stageSlug as keyof typeof CANONICAL_DEAL_STAGE_LABELS;
  }

  const legacyMap =
    workflowRoute === "service"
      ? LEGACY_SERVICE_DASHBOARD_STAGE_SLUGS
      : LEGACY_NORMAL_DASHBOARD_STAGE_SLUGS;

  return legacyMap[stageSlug as keyof typeof legacyMap] ?? null;
}

function resolveDealSnapshotStageLabel(
  workflowRoute: WorkflowRoute,
  stageSlug: string | null | undefined,
  mirroredStageSlug: string | null | undefined,
  fallbackStageName: string | null | undefined
) {
  const resolvedSlug =
    resolveCanonicalDealStageSlug(workflowRoute, mirroredStageSlug) ??
    resolveCanonicalDealStageSlug(workflowRoute, stageSlug);

  if (resolvedSlug) {
    return CANONICAL_DEAL_STAGE_LABELS[resolvedSlug];
  }

  return fallbackStageName ?? "Unknown";
}

export interface FunnelBucketSummary {
  key: "lead" | "qualified_lead" | "opportunity" | "estimating";
  label: string;
  count: number;
  totalValue: number | null;
  route: "/leads" | "/deals";
  bucket: "lead" | "qualified_lead" | "opportunity" | "estimating";
}

export interface DirectorRepFunnelRow {
  repId: string;
  repName: string;
  leads: number;
  qualifiedLeads: number;
  opportunities: number;
  estimating: number;
}

export interface RepCommissionSummary {
  commissionRate: number;
  overrideRate: number;
  rollingFloor: number;
  rollingPaidRevenue: number;
  rollingCommissionableMargin: number;
  floorRemaining: number;
  newCustomerRevenue: number;
  newCustomerShare: number;
  newCustomerShareFloor: number;
  meetsNewCustomerShare: boolean;
  estimatedPaymentCount: number;
  excludedLowMarginRevenue: number;
  directEarnedCommission: number;
  overrideEarnedCommission: number;
  totalEarnedCommission: number;
  potentialRevenue: number;
  potentialMargin: number;
  potentialCommission: number;
}

export interface RepCommissionDealEarning {
  dealId: string;
  dealNumber: string | null;
  dealName: string;
  companyName: string | null;
  propertyName: string | null;
  paidRevenue: number;
  commissionableMargin: number;
  earnedCommission: number;
  paymentCount: number;
  lastPaidAt: string | null;
}

export interface DirectorRepCommissionRow {
  repId: string;
  repName: string;
  totalEarnedCommission: number;
  potentialCommission: number;
  floorRemaining: number;
  newCustomerShare: number;
  meetsNewCustomerShare: boolean;
}

export interface StaleLeadDashboardRow {
  leadId: string;
  leadName: string;
  companyName: string;
  propertyName: string;
  stageName: string;
  repName: string;
  daysInStage: number;
  pipelineType?: "normal" | "service";
  locationLabel?: string | null;
  estimatedValue?: number;
  staleThresholdDays?: number;
  daysPastDue?: number;
}

interface StaleLeadWatchlistSqlRow extends Record<string, unknown> {
  lead_id: string;
  lead_name: string;
  company_name: string;
  property_name: string;
  stage_name: string;
  rep_name: string;
  stage_entered_at: string | Date | null;
  pipeline_type: "normal" | "service" | null;
  location_label: string | null;
  estimated_value: number | string | null;
}

export interface DashboardCrmOwnedProgressionRow {
  workflowBucket: "lead" | "opportunity";
  workflowRoute: "normal" | "service";
  stageName: string;
  itemCount: number;
  totalValue: number;
}

export interface DashboardDownstreamBottleneckRow {
  dealId: string;
  repId: string | null;
  repName: string;
  dealName: string;
  stageName: string;
  mirroredStageStatus: string | null;
  workflowRoute: "normal" | "service";
  regionClassification: string;
  dealValue: number;
  daysInStage: number;
  staleThresholdDays: number;
  atRisk?: AtRiskResult;
}

export interface DashboardAtRiskDealRow extends DashboardDownstreamBottleneckRow {
  atRisk: AtRiskResult;
}

export interface MyCleanupSummary {
  total: number;
  byReason: Array<{ reasonCode: string; count: number }>;
}

async function getStaleLeadWatchlist(
  tenantDb: TenantDb,
  options: DashboardScopeOptions = {}
): Promise<StaleLeadDashboardRow[]> {
  // Current-state operational watchlist: intentionally anchored to wall-clock NOW(),
  // not the A5a rep-performance snapshot period boundary.
  const repFilter = leadScopeFilterSql("l", options);

  const result = await tenantDb.execute<StaleLeadWatchlistSqlRow>(sql`
    SELECT
      l.id AS lead_id,
      l.name AS lead_name,
      c.name AS company_name,
      p.name AS property_name,
      psc.name AS stage_name,
      u.display_name AS rep_name,
      l.stage_entered_at,
      l.pipeline_type,
      TRIM(CONCAT_WS(', ', p.city, p.state)) AS location_label,
      COALESCE(l.pre_qual_value, 0)::numeric AS estimated_value
    FROM leads l
    JOIN companies c ON c.id = l.company_id
    JOIN properties p ON p.id = l.property_id
    JOIN pipeline_stage_config psc ON psc.id = l.stage_id
    JOIN users u ON u.id = l.assigned_rep_id
    WHERE l.is_active = true
      AND l.status = 'open'
      AND psc.workflow_family = 'lead'
      AND psc.is_terminal = false
      ${repFilter}
    ORDER BY l.stage_entered_at ASC, l.updated_at ASC
  `);

  const rows = rowsFromExecute(result);
  const now = new Date();
  return rows
    .map((row) => {
      const atRisk = getLeadStaleAtRiskResult(row.stage_entered_at, row.pipeline_type, now);
      return { row, atRisk };
    })
    .filter(({ atRisk }) => atRisk.isAtRisk)
    .map(({ row, atRisk }) => ({
      leadId: row.lead_id,
      leadName: row.lead_name,
      companyName: row.company_name,
      propertyName: row.property_name,
      stageName: row.stage_name,
      repName: row.rep_name,
      daysInStage: atRisk.effectiveStageAgeDays,
      pipelineType: row.pipeline_type ?? "normal",
      locationLabel: row.location_label || null,
      estimatedValue: Number(row.estimated_value ?? 0),
      staleThresholdDays: atRisk.thresholdDays ?? 0,
      daysPastDue: Math.max(0, atRisk.effectiveStageAgeDays - (atRisk.thresholdDays ?? 0)),
    }));
}

async function getCrmOwnedProgression(
  tenantDb: TenantDb,
  options: DashboardScopeOptions = {}
): Promise<DashboardCrmOwnedProgressionRow[]> {
  const leadRepFilter = leadScopeFilterSql("l", options);
  const dealRepFilter = dealScopeFilterSql("d", options);

  const result = await tenantDb.execute(sql`
    SELECT
      workflow_bucket,
      workflow_route,
      stage_name,
      MIN(display_order)::int AS display_order,
      SUM(item_count)::int AS item_count,
      COALESCE(SUM(total_value), 0)::numeric AS total_value
    FROM (
      SELECT
        'lead'::text AS workflow_bucket,
        l.pipeline_type::text AS workflow_route,
        psc.name AS stage_name,
        psc.display_order,
        COUNT(*)::int AS item_count,
        COALESCE(SUM(COALESCE(l.pre_qual_value, 0)), 0)::numeric AS total_value
      FROM leads l
      JOIN pipeline_stage_config psc ON psc.id = l.stage_id
      WHERE l.is_active = true
        AND l.status = 'open'
        AND psc.workflow_family = 'lead'
        ${leadRepFilter}
      GROUP BY l.pipeline_type, psc.name, psc.display_order

      UNION ALL

      SELECT
        'opportunity'::text AS workflow_bucket,
        d.workflow_route::text AS workflow_route,
        psc.name AS stage_name,
        psc.display_order,
        COUNT(*) FILTER (WHERE ${aliasedActiveDealCountFilterSql("d")})::int AS item_count,
        COALESCE(SUM(${dealValueSql()}), 0)::numeric AS total_value
      FROM deals d
      JOIN pipeline_stage_config psc ON psc.id = d.stage_id
      WHERE d.is_active = true
        AND ${aliasedActiveDealCountFilterSql("d")}
        AND psc.slug = 'opportunity'
        ${dealRepFilter}
      GROUP BY d.workflow_route, psc.name, psc.display_order
    ) crm_owned_progression
    GROUP BY workflow_bucket, workflow_route, stage_name
    ORDER BY display_order ASC, workflow_route ASC
  `);

  const rows = (result as any).rows ?? result;
  return rows.map((row: any) => ({
    workflowBucket: row.workflow_bucket,
    workflowRoute: row.workflow_route,
    stageName: row.stage_name,
    itemCount: Number(row.item_count ?? 0),
    totalValue: Number(row.total_value ?? 0),
  }));
}

async function getDownstreamBottlenecks(
  tenantDb: TenantDb,
  options: DashboardScopeOptions = {}
): Promise<DashboardDownstreamBottleneckRow[]> {
  const rows = await getDashboardAtRiskRows(tenantDb, options);
  return buildDashboardDownstreamBottlenecks(rows, options.viewerRole ?? "rep");
}

function dealValueSql() {
  return aliasedEffectiveDealValueSql("d");
}

function recentCloseDealValueSql() {
  return sql`
    CASE
      WHEN psc.slug IN (${sql.join([...WON_STAGE_SLUGS, ...LEGACY_WON_STAGE_SLUGS].map((slug) => sql`${slug}`), sql`, `)})
        THEN ${aliasedEffectiveDealValueSql(
          "d",
          sql`COALESCE(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0)`
        )}
      ELSE ${dealValueSql()}
    END
  `;
}

function toIsoOrNow(value: unknown): string {
  if (!value) {
    return new Date(0).toISOString();
  }
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function buildFunnelBuckets(leadRows: any[], dealRows: any[]): FunnelBucketSummary[] {
  const leadCounts = new Map<string, number>(
    leadRows.map((row) => [String(row.slug), Number(row.count ?? 0)])
  );
  const dealCounts = new Map<string, number>(
    dealRows.map((row) => [String(row.slug), Number(row.count ?? 0)])
  );
  const dealValues = new Map<string, number>(
    dealRows.map((row) => [String(row.slug), Number(row.total_value ?? 0)])
  );

  return [
    {
      key: "lead",
      label: "Leads",
      count:
        (leadCounts.get("lead_new") ?? 0) +
        (leadCounts.get("company_pre_qualified") ?? 0) +
        (leadCounts.get("scoping_in_progress") ?? 0) +
        (leadCounts.get("new_lead") ?? 0),
      totalValue: null,
      route: "/leads",
      bucket: "lead",
    },
    {
      key: "qualified_lead",
      label: "Qualified Leads",
      count:
        (leadCounts.get("pre_qual_value_assigned") ?? 0) +
        (leadCounts.get("lead_go_no_go") ?? 0) +
        (leadCounts.get("qualified_lead") ?? 0),
      totalValue: null,
      route: "/leads",
      bucket: "qualified_lead",
    },
    {
      key: "opportunity",
      label: "Opportunities",
      count:
        (leadCounts.get("qualified_for_opportunity") ?? 0) +
        (leadCounts.get("sales_validation_stage") ?? 0) +
        (leadCounts.get("opportunity") ?? 0),
      totalValue: null,
      route: "/leads",
      bucket: "opportunity",
    },
    {
      key: "estimating",
      label: "Bid Board Pipeline",
      count: ESTIMATING_PROGRESS_STAGE_SLUGS.reduce((sum, slug) => sum + (dealCounts.get(slug) ?? 0), 0),
      totalValue: ESTIMATING_PROGRESS_STAGE_SLUGS.reduce((sum, slug) => sum + (dealValues.get(slug) ?? 0), 0),
      route: "/deals",
      bucket: "estimating",
    },
  ];
}

async function getRepFunnelBuckets(
  tenantDb: TenantDb,
  options: DashboardScopeOptions
): Promise<FunnelBucketSummary[]> {
  const leadRepFilter = leadScopeFilterSql("l", options);
  const dealRepFilter = dealScopeFilterSql("d", options);
  const [leadResult, dealResult] = await runSequential([
    () => tenantDb.execute(sql`
      SELECT
        psc.slug,
        COUNT(*)::int AS count
      FROM leads l
      JOIN pipeline_stage_config psc ON psc.id = l.stage_id
      WHERE l.status = 'open'
        AND l.is_active = true
        AND psc.workflow_family = 'lead'
        ${leadRepFilter}
      GROUP BY psc.slug
    `),
    () => tenantDb.execute(sql`
      SELECT
        psc.slug,
        COUNT(*) FILTER (WHERE ${aliasedActiveDealCountFilterSql("d")})::int AS count,
        COALESCE(SUM(${dealValueSql()}), 0)::numeric AS total_value
      FROM deals d
      JOIN pipeline_stage_config psc ON psc.id = d.stage_id
      WHERE d.is_active = true
        AND ${aliasedActiveDealCountFilterSql("d")}
        ${dealRepFilter}
        AND psc.slug IN (${sql.join(ESTIMATING_PROGRESS_STAGE_SLUGS.map((slug) => sql`${slug}`), sql`, `)})
      GROUP BY psc.slug
    `),
  ]);

  const leadRows = (leadResult as any).rows ?? leadResult;
  const dealRows = (dealResult as any).rows ?? dealResult;
  return buildFunnelBuckets(leadRows, dealRows);
}

async function getDirectorFunnelSummary(
  tenantDb: TenantDb
): Promise<{ officeFunnelBuckets: FunnelBucketSummary[]; repFunnelRows: DirectorRepFunnelRow[] }> {
  const [leadResult, dealResult, repRowsResult] = await runSequential([
    () => tenantDb.execute(sql`
      SELECT
        psc.slug,
        COUNT(*)::int AS count
      FROM leads l
      JOIN pipeline_stage_config psc ON psc.id = l.stage_id
      WHERE l.status = 'open'
        AND l.is_active = true
        AND psc.workflow_family = 'lead'
      GROUP BY psc.slug
    `),
    () => tenantDb.execute(sql`
      SELECT
        psc.slug,
        COUNT(*) FILTER (WHERE ${aliasedActiveDealCountFilterSql("d")})::int AS count,
        COALESCE(SUM(${dealValueSql()}), 0)::numeric AS total_value
      FROM deals d
      JOIN pipeline_stage_config psc ON psc.id = d.stage_id
      WHERE d.is_active = true
        AND ${aliasedActiveDealCountFilterSql("d")}
        AND psc.slug IN (${sql.join(ESTIMATING_PROGRESS_STAGE_SLUGS.map((slug) => sql`${slug}`), sql`, `)})
      GROUP BY psc.slug
    `),
    () => tenantDb.execute(sql`
      WITH deal_owners AS (
        -- Locked requirement: widen the rep workspace for deal-owning non-reps
        -- without widening it for lead-only directors/admins.
        SELECT DISTINCT d.assigned_rep_id AS rep_id
        FROM deals d
        WHERE d.assigned_rep_id IS NOT NULL
      ),
      lead_counts AS (
        SELECT
          l.assigned_rep_id AS rep_id,
          COUNT(*) FILTER (
            WHERE psc.slug IN ('lead_new', 'company_pre_qualified', 'scoping_in_progress', 'new_lead')
          )::int AS leads,
          COUNT(*) FILTER (
            WHERE psc.slug IN ('pre_qual_value_assigned', 'lead_go_no_go', 'qualified_lead')
          )::int AS qualified_leads,
          COUNT(*) FILTER (
            WHERE psc.slug IN ('qualified_for_opportunity', 'sales_validation_stage', 'opportunity')
          )::int AS opportunities
        FROM leads l
        JOIN pipeline_stage_config psc ON psc.id = l.stage_id
        WHERE l.status = 'open'
          AND l.is_active = true
          AND psc.workflow_family = 'lead'
        GROUP BY l.assigned_rep_id
      ),
      deal_counts AS (
        SELECT
          d.assigned_rep_id AS rep_id,
          COUNT(*) FILTER (
            WHERE psc.slug IN (${sql.join(ESTIMATING_PROGRESS_STAGE_SLUGS.map((slug) => sql`${slug}`), sql`, `)})
              AND ${aliasedActiveDealCountFilterSql("d")}
          )::int AS estimating
        FROM deals d
        JOIN pipeline_stage_config psc ON psc.id = d.stage_id
        WHERE d.is_active = true
          AND psc.slug IN (${sql.join(ESTIMATING_PROGRESS_STAGE_SLUGS.map((slug) => sql`${slug}`), sql`, `)})
        GROUP BY d.assigned_rep_id
      )
      SELECT
        u.id AS rep_id,
        u.display_name AS rep_name,
        COALESCE(lc.leads, 0)::int AS leads,
        COALESCE(lc.qualified_leads, 0)::int AS qualified_leads,
        COALESCE(lc.opportunities, 0)::int AS opportunities,
        COALESCE(dc.estimating, 0)::int AS estimating
      FROM users u
      LEFT JOIN deal_owners owner_rows ON owner_rows.rep_id = u.id
      LEFT JOIN lead_counts lc ON lc.rep_id = u.id
      LEFT JOIN deal_counts dc ON dc.rep_id = u.id
      WHERE u.is_active = true
        AND (u.role = 'rep' OR owner_rows.rep_id IS NOT NULL)
      ORDER BY
        (
          COALESCE(lc.leads, 0) +
          COALESCE(lc.qualified_leads, 0) +
          COALESCE(lc.opportunities, 0) +
          COALESCE(dc.estimating, 0)
        ) DESC,
        u.display_name ASC
    `),
  ]);

  const leadRows = (leadResult as any).rows ?? leadResult;
  const dealRows = (dealResult as any).rows ?? dealResult;
  const repRows = ((repRowsResult as any).rows ?? repRowsResult).map((row: any) => ({
    repId: row.rep_id,
    repName: row.rep_name,
    leads: Number(row.leads ?? 0),
    qualifiedLeads: Number(row.qualified_leads ?? 0),
    opportunities: Number(row.opportunities ?? 0),
    estimating: Number(row.estimating ?? 0),
  })).sort((a: DirectorRepFunnelRow, b: DirectorRepFunnelRow) => {
    const totalA = a.leads + a.qualifiedLeads + a.opportunities + a.estimating;
    const totalB = b.leads + b.qualifiedLeads + b.opportunities + b.estimating;
    if (totalB !== totalA) return totalB - totalA;
    return a.repName.localeCompare(b.repName);
  });

  return {
    officeFunnelBuckets: buildFunnelBuckets(leadRows, dealRows),
    repFunnelRows: repRows,
  };
}

type CommissionConfig = {
  isActive: boolean;
  commissionRate: number;
  rollingFloor: number;
  overrideRate: number;
  estimatedMarginRate: number;
  minMarginPercent: number;
  newCustomerShareFloor: number;
  newCustomerWindowMonths: number;
};

type DirectCommissionMetrics = {
  rollingPaidRevenue: number;
  rollingCommissionableMargin: number;
  newCustomerRevenue: number;
  newCustomerShare: number;
  meetsNewCustomerShare: boolean;
  estimatedPaymentCount: number;
  excludedLowMarginRevenue: number;
  floorRemaining: number;
  eligibleMarginAfterFloor: number;
  directEarnedCommission: number;
};

type CommissionDealRollup = {
  dealId: string;
  dealNumber: string | null;
  dealName: string;
  companyName: string | null;
  propertyName: string | null;
  paidRevenue: number;
  commissionableMargin: number;
  earnedCommission: number;
  paymentCount: number;
  lastPaidAt: string | null;
};

function dashboardEarnedSignedDateSql() {
  return sql`COALESCE(d.contract_signed_at::date, d.contract_signed_date, dsc.contract_signed_date_at_signing)`;
}

function dashboardNotOnHoldDealSql() {
  return sql`AND ${aliasedActiveDealCountFilterSql("d")}`;
}

async function getCommissionConfig(tenantDb: TenantDb, userId: string): Promise<CommissionConfig> {
  const result = await tenantDb.execute(sql`
    SELECT
      COALESCE(cs.is_active, true) AS is_active,
      COALESCE(cs.commission_rate, 0)::numeric AS commission_rate,
      COALESCE(cs.rolling_floor, 0)::numeric AS rolling_floor,
      COALESCE(cs.override_rate, 0)::numeric AS override_rate,
      COALESCE(cs.estimated_margin_rate, 0.30)::numeric AS estimated_margin_rate,
      COALESCE(cs.min_margin_percent, 0.20)::numeric AS min_margin_percent,
      COALESCE(cs.new_customer_share_floor, 0.10)::numeric AS new_customer_share_floor,
      COALESCE(cs.new_customer_window_months, 6)::int AS new_customer_window_months
    FROM public.users u
    LEFT JOIN public.user_commission_settings cs ON cs.user_id = u.id
    WHERE u.id = ${userId}
    LIMIT 1
  `);
  const rows = (result as any).rows ?? result;
  const row = rows[0] ?? {};
  return {
    isActive: Boolean(row.is_active ?? true),
    commissionRate: Number(row.commission_rate ?? 0),
    rollingFloor: Number(row.rolling_floor ?? 0),
    overrideRate: Number(row.override_rate ?? 0),
    estimatedMarginRate: Number(row.estimated_margin_rate ?? 0.30),
    minMarginPercent: Number(row.min_margin_percent ?? 0.20),
    newCustomerShareFloor: Number(row.new_customer_share_floor ?? 0.10),
    newCustomerWindowMonths: Number(row.new_customer_window_months ?? 6),
  };
}

async function getDirectCommissionMetrics(
  tenantDb: TenantDb,
  repId: string,
  _config: CommissionConfig,
  fromDate: string,
  toDate: string
): Promise<DirectCommissionMetrics> {
  const result = await tenantDb.execute(sql`
    SELECT
      COALESCE(SUM(dsc.source_value_amount), 0)::numeric AS source_value_amount,
      COALESCE(SUM(dsc.amount), 0)::numeric AS earned_commission
    FROM ${dealSignedCommissions} dsc
    JOIN ${deals} d ON d.id = dsc.deal_id
    JOIN ${pipelineStageConfig} psc ON psc.id = d.stage_id
    WHERE dsc.rep_user_id = ${repId}
      AND COALESCE(d.is_test_data, false) = false
      AND ${dashboardEarnedSignedDateSql()} IS NOT NULL
      AND psc.slug NOT IN ('lost', 'production_lost', 'service_lost', 'closed_lost')
      ${dashboardNotOnHoldDealSql()}
      AND ${dashboardEarnedSignedDateSql()} >= ${fromDate}
      AND ${dashboardEarnedSignedDateSql()} <= ${toDate}
  `);

  const rows = (result as any).rows ?? result;
  const row = rows[0] ?? {};
  const sourceValueAmount = Number(row.source_value_amount ?? 0);
  const directEarnedCommission = Number(Number(row.earned_commission ?? 0).toFixed(2));

  return {
    rollingPaidRevenue: sourceValueAmount,
    rollingCommissionableMargin: sourceValueAmount,
    newCustomerRevenue: 0,
    newCustomerShare: 0,
    meetsNewCustomerShare: true,
    estimatedPaymentCount: 0,
    excludedLowMarginRevenue: 0,
    floorRemaining: 0,
    eligibleMarginAfterFloor: sourceValueAmount,
    directEarnedCommission,
  };
}

async function getCommissionDealRollups(
  tenantDb: TenantDb,
  repId: string,
  _config: CommissionConfig,
  fromDate: string,
  toDate: string
): Promise<CommissionDealRollup[]> {
  const result = await tenantDb.execute(sql`
    SELECT
      d.id AS deal_id,
      d.deal_number AS deal_number,
      d.name AS deal_name,
      c.name AS company_name,
      p.name AS property_name,
      dsc.source_value_amount::numeric AS paid_revenue,
      dsc.source_value_amount::numeric AS commissionable_margin,
      dsc.amount::numeric AS earned_commission,
      0::int AS payment_count,
      ${dashboardEarnedSignedDateSql()} AS last_paid_at
    FROM ${dealSignedCommissions} dsc
    JOIN ${deals} d ON d.id = dsc.deal_id
    JOIN ${pipelineStageConfig} psc ON psc.id = d.stage_id
    LEFT JOIN ${companies} c ON c.id = d.company_id
    LEFT JOIN ${properties} p ON p.id = d.property_id
    WHERE dsc.rep_user_id = ${repId}
      AND COALESCE(d.is_test_data, false) = false
      AND ${dashboardEarnedSignedDateSql()} IS NOT NULL
      AND psc.slug NOT IN ('lost', 'production_lost', 'service_lost', 'closed_lost')
      ${dashboardNotOnHoldDealSql()}
      AND ${dashboardEarnedSignedDateSql()} >= ${fromDate}
      AND ${dashboardEarnedSignedDateSql()} <= ${toDate}
    ORDER BY ${dashboardEarnedSignedDateSql()} DESC, d.name ASC
  `);

  const rows = (result as any).rows ?? result;
  return rows.map((row: any) => ({
    dealId: String(row.deal_id),
    dealNumber: row.deal_number ? String(row.deal_number) : null,
    dealName: String(row.deal_name ?? "Deal"),
    companyName: row.company_name ? String(row.company_name) : null,
    propertyName: row.property_name ? String(row.property_name) : null,
    paidRevenue: Number(row.paid_revenue ?? 0),
    commissionableMargin: Number(row.commissionable_margin ?? 0),
    earnedCommission: Number(row.earned_commission ?? 0),
    paymentCount: Number(row.payment_count ?? 0),
    lastPaidAt: row.last_paid_at ? new Date(`${String(row.last_paid_at).slice(0, 10)}T00:00:00.000Z`).toISOString() : null,
  }));
}

function allocateDealCommissions(
  rollups: CommissionDealRollup[],
  direct: DirectCommissionMetrics
): RepCommissionDealEarning[] {
  if (direct.directEarnedCommission <= 0) return [];
  return rollups.filter((rollup) => rollup.earnedCommission > 0);
}

async function getRepPotentialRevenue(tenantDb: TenantDb, repId: string): Promise<number> {
  const result = await tenantDb.execute(sql`
    SELECT
      COALESCE(
        SUM(
          COALESCE(NULLIF(d.bid_board_total_sales, 0), NULLIF(d.bid_estimate, 0), NULLIF(d.dd_estimate, 0), d.awarded_amount, 0) + COALESCE(d.change_order_total, 0)
        ),
        0
      )::numeric AS potential_revenue
    FROM ${deals} d
    JOIN ${pipelineStageConfig} psc ON psc.id = d.stage_id
    WHERE d.assigned_rep_id = ${repId}
      AND d.is_active = true
      AND COALESCE(d.is_test_data, false) = false
      AND d.contract_signed_at IS NULL
      AND d.contract_signed_date IS NULL
      ${dashboardNotOnHoldDealSql()}
      AND psc.slug IN (${sql.join(COMMISSION_PIPELINE_STAGE_SLUGS.map((slug) => sql`${slug}`), sql`, `)})
  `);
  const rows = (result as any).rows ?? result;
  return Number(rows[0]?.potential_revenue ?? 0);
}

async function getOverrideEarnedCommission(
  tenantDb: TenantDb,
  managerId: string,
  managerOverrideRate: number,
  fromDate: string,
  toDate: string
): Promise<number> {
  if (managerOverrideRate <= 0) return 0;

  const result = await tenantDb.execute(sql`
    SELECT COALESCE(SUM(dsc.amount * ${String(managerOverrideRate)}::numeric), 0)::numeric AS override_earned
    FROM ${users} u
    JOIN ${dealSignedCommissions} dsc ON dsc.rep_user_id = u.id
    JOIN ${deals} d ON d.id = dsc.deal_id
    JOIN ${pipelineStageConfig} psc ON psc.id = d.stage_id
    WHERE u.is_active = true
      AND u.role = 'rep'
      AND u.reports_to = ${managerId}
      AND COALESCE(d.is_test_data, false) = false
      AND ${dashboardEarnedSignedDateSql()} IS NOT NULL
      AND psc.slug NOT IN ('lost', 'production_lost', 'service_lost', 'closed_lost')
      ${dashboardNotOnHoldDealSql()}
      AND ${dashboardEarnedSignedDateSql()} >= ${fromDate}
      AND ${dashboardEarnedSignedDateSql()} <= ${toDate}
  `);
  const rows = (result as any).rows ?? result;
  return Number(Number(rows[0]?.override_earned ?? 0).toFixed(2));
}

async function getRepCommissionSummary(
  tenantDb: TenantDb,
  repId: string,
  fromDate: string,
  toDate: string
): Promise<{ summary: RepCommissionSummary; deals: RepCommissionDealEarning[] }> {
  const rawConfig = await getCommissionConfig(tenantDb, repId);
  const config = rawConfig.isActive
    ? rawConfig
    : {
        ...rawConfig,
        commissionRate: 0,
        rollingFloor: 0,
        overrideRate: 0,
      };
  const direct = await getDirectCommissionMetrics(tenantDb, repId, config, fromDate, toDate);
  const commissionRollups = await getCommissionDealRollups(tenantDb, repId, config, fromDate, toDate);
  const potentialRevenue = await getRepPotentialRevenue(tenantDb, repId);
  const potentialMargin = potentialRevenue;
  const potentialEligibleRevenue = Math.max(potentialRevenue - direct.floorRemaining, 0);
  const potentialCommission = Number((potentialEligibleRevenue * config.commissionRate).toFixed(2));
  const overrideEarnedCommission = await getOverrideEarnedCommission(tenantDb, repId, config.overrideRate, fromDate, toDate);
  const totalEarnedCommission = Number((direct.directEarnedCommission + overrideEarnedCommission).toFixed(2));
  const deals = allocateDealCommissions(commissionRollups, direct);

  return {
    summary: {
      commissionRate: config.commissionRate,
      overrideRate: config.overrideRate,
      rollingFloor: config.rollingFloor,
      rollingPaidRevenue: direct.rollingPaidRevenue,
      rollingCommissionableMargin: direct.rollingCommissionableMargin,
      floorRemaining: direct.floorRemaining,
      newCustomerRevenue: direct.newCustomerRevenue,
      newCustomerShare: direct.newCustomerShare,
      newCustomerShareFloor: config.newCustomerShareFloor,
      meetsNewCustomerShare: direct.meetsNewCustomerShare,
      estimatedPaymentCount: direct.estimatedPaymentCount,
      excludedLowMarginRevenue: direct.excludedLowMarginRevenue,
      directEarnedCommission: direct.directEarnedCommission,
      overrideEarnedCommission,
      totalEarnedCommission,
      potentialRevenue,
      potentialMargin,
      potentialCommission,
    },
    deals,
  };
}

async function getDirectorRepCommissionRows(
  tenantDb: TenantDb,
  options: { from: string; to: string }
): Promise<DirectorRepCommissionRow[]> {
  const repsResult = await tenantDb.execute(sql`
    SELECT id, display_name
    FROM ${users}
    WHERE is_active = true
      AND role = 'rep'
    ORDER BY display_name ASC
  `);
  const reps = (repsResult as any).rows ?? repsResult;
  if (reps.length === 0) return [];

  const rows: DirectorRepCommissionRow[] = [];
  for (const rep of reps) {
    const { summary } = await getRepCommissionSummary(tenantDb, String(rep.id), options.from, options.to);
    rows.push({
      repId: String(rep.id),
      repName: String(rep.display_name ?? "Rep"),
      totalEarnedCommission: summary.totalEarnedCommission,
      potentialCommission: summary.potentialCommission,
      floorRemaining: summary.floorRemaining,
      newCustomerShare: summary.newCustomerShare,
      meetsNewCustomerShare: summary.meetsNewCustomerShare,
    });
  }

  return rows.sort((a, b) => {
    if (b.totalEarnedCommission !== a.totalEarnedCommission) {
      return b.totalEarnedCommission - a.totalEarnedCommission;
    }
    if (b.potentialCommission !== a.potentialCommission) {
      return b.potentialCommission - a.potentialCommission;
    }
    return a.repName.localeCompare(b.repName);
  });
}

// ---------------------------------------------------------------------------
// Per-Rep Dashboard
// ---------------------------------------------------------------------------

export interface RepDashboardData {
  activeLeads: { count: number };
  funnelBuckets: FunnelBucketSummary[];
  commissionSummary: RepCommissionSummary;
  commissionDeals: RepCommissionDealEarning[];
  activeDeals: { count: number; totalValue: number };
  contractsSignedYtd: { count: number; totalValue: number };
  contractsSignedMtd: { count: number; totalValue: number };
  tasksToday: { overdue: number; today: number };
  /**
   * Activity counts by type within the range passed to getRepDashboard
   * (`week` | `month` | `ytd`). Field name is legacy: when the range is
   * non-week the contents are month/YTD totals despite the "ThisWeek"
   * label. Preserved for compatibility with getRepDetail and
   * director-rep-detail.tsx; a coordinated rename to `activitySummary`
   * is tracked under "Naming debt" in TODO.md.
   */
  activityThisWeek: { calls: number; emails: number; meetings: number; notes: number; total: number };
  followUpCompliance: { total: number; onTime: number; complianceRate: number };
  pipelineByStage: Array<{
    stageId: string;
    stageName: string;
    stageColor: string | null;
    dealCount: number;
    totalValue: number;
  }>;
  staleLeads: {
    count: number;
    averageDaysInStage: number | null;
    leads: StaleLeadDashboardRow[];
  };
  crmOwnedProgression: DashboardCrmOwnedProgressionRow[];
  downstreamBottlenecks: DashboardDownstreamBottleneckRow[];
  leadSnapshot: Array<{
    leadId: string;
    leadName: string;
    companyName: string | null;
    propertyName: string | null;
    stageName: string;
    daysInStage: number;
    updatedAt: string;
  }>;
  dealSnapshot: Array<{
    dealId: string;
    dealName: string;
    companyName: string | null;
    propertyName: string | null;
    stageName: string;
    totalValue: number;
    updatedAt: string;
  }>;
  myCleanup: MyCleanupSummary;
}

async function runSequential<T extends readonly unknown[]>(
  steps: { [K in keyof T]: () => Promise<T[K]> }
): Promise<T> {
  const results: unknown[] = [];
  for (const step of steps) {
    results.push(await step());
  }
  return results as unknown as T;
}

/**
 * Aggregate all data for the per-rep dashboard.
 * Queries stay sequential because tenantDb is bound to a single client per request.
 */
export async function getRepDashboard(
  tenantDb: TenantDb,
  userId: string,
  options: {
    range?: ActivityRange;
    activityDateRange?: { from?: string; to?: string };
    followUpDateRange?: { from?: string; to?: string };
    commissionDateRange?: { from?: string; to?: string };
  } = {}
): Promise<RepDashboardData> {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" }); // YYYY-MM-DD in CT

  const now = new Date();
  const year = now.getFullYear();
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const monthStart = `${year}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

  const explicitActivityDateRange = options.activityDateRange?.from
    ? {
        from: options.activityDateRange.from,
        to: options.activityDateRange.to ?? today,
      }
    : null;

  // Activity range start as a YYYY-MM-DD string. SQL applies AT TIME ZONE
  // 'America/Chicago' to anchor it to CT midnight (DST-aware via Postgres,
  // never wrong regardless of process TZ). Unknown range values silently
  // fall back to the default — matches house-style query-param handling.
  const range: ActivityRange = (
    options.range && (["week", "month", "ytd"] as const).includes(options.range as never)
      ? options.range
      : DEFAULT_ACTIVITY_RANGE
  ) as ActivityRange;
  let activityRangeStartDate: string;
  if (explicitActivityDateRange) {
    activityRangeStartDate = explicitActivityDateRange.from;
  } else if (range === "month") {
    activityRangeStartDate = `${today.slice(0, 7)}-01`;
  } else if (range === "ytd") {
    activityRangeStartDate = `${today.slice(0, 4)}-01-01`;
  } else {
    // week — calendar-aligned 7-day window in CT. Slightly different from
    // the prior sliding-millisecond-window: the start anchors to midnight
    // CT 7 days ago, so the bucket doesn't drift through the day. Subtle
    // change, but more honest as a "Week" label.
    const [y, m, d] = today.split("-").map(Number);
    const ref = new Date(Date.UTC(y!, m! - 1, d!) - 7 * 24 * 60 * 60 * 1000);
    activityRangeStartDate = `${ref.getUTCFullYear()}-${String(ref.getUTCMonth() + 1).padStart(2, "0")}-${String(ref.getUTCDate()).padStart(2, "0")}`;
  }
  const activityRangeEndDate = explicitActivityDateRange?.to ?? today;
  const followUpDateRange = options.followUpDateRange ?? { from: yearStart, to: yearEnd };
  const commissionDateRange = options.commissionDateRange ?? { from: activityRangeStartDate, to: today };
  const mineVisibility = await resolveMineVisibilityFeatures(tenantDb);

  const [
    activeLeadResult,
    activeDealResult,
    taskCountResult,
    activityResult,
    complianceResult,
    pipelineResult,
    staleLeadResult,
    crmOwnedProgression,
    downstreamBottlenecks,
    leadSnapshotResult,
    dealSnapshotResult,
    funnelBuckets,
    myCleanupResult,
    commissionData,
    contractsSignedResult,
  ] = await runSequential([
    () => tenantDb.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM leads l
      JOIN pipeline_stage_config psc ON psc.id = l.stage_id
      WHERE l.is_active = true
        AND l.status = 'open'
        AND ${buildAliasedLeadMineVisibilityCondition("l", userId, {
          includeSubscriptions: mineVisibility.leadSubscriptions,
          includeCreatedBy: mineVisibility.leadsCreatedByUserId,
          includeSubscriptionDeletedAt: mineVisibility.leadSubscriptionsDeletedAt,
        })}
        AND NOT psc.is_terminal
    `),

    // 1. Active deals count + value for this rep
    () => tenantDb.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE ${aliasedActiveDealCountFilterSql("d")})::int AS count,
        COALESCE(SUM(${dealValueSql()}), 0)::numeric AS total_value
      FROM deals d
      JOIN pipeline_stage_config psc ON psc.id = d.stage_id
      WHERE d.is_active = true
        AND ${aliasedActiveDealCountFilterSql("d")}
        AND ${buildAliasedDealMineVisibilityCondition("d", userId, {
          includeSubscriptions: mineVisibility.dealSubscriptions,
          includeCreatedBy: mineVisibility.dealsCreatedByUserId,
          includeSubscriptionDeletedAt: mineVisibility.dealSubscriptionsDeletedAt,
        })}
        AND ${nonTerminalDealStageSql()}
    `),

    // 2. Tasks: overdue + today counts
    () => tenantDb.execute(sql`
      SELECT
        COUNT(*) FILTER (
          WHERE status IN ('pending', 'in_progress') AND due_date < ${today}
        )::int AS overdue,
        COUNT(*) FILTER (
          WHERE status IN ('pending', 'in_progress') AND due_date = ${today}
        )::int AS today
      FROM tasks
      WHERE assigned_to = ${userId}
    `),

    // 3. Activity by type within the selected range (week | month | ytd)
    () => tenantDb.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE type = 'call')::int AS calls,
        COUNT(*) FILTER (WHERE type = 'email')::int AS emails,
        COUNT(*) FILTER (WHERE type = 'meeting')::int AS meetings,
        COUNT(*) FILTER (WHERE type = 'note')::int AS notes,
        COUNT(*)::int AS total
      FROM activities
      WHERE responsible_user_id = ${userId}
        AND occurred_at >= (${activityRangeStartDate}::date AT TIME ZONE 'America/Chicago')
        AND occurred_at < ((${activityRangeEndDate}::date + INTERVAL '1 day') AT TIME ZONE 'America/Chicago')
    `),

    // 4. Follow-up compliance
    () => getFollowUpCompliance(tenantDb, userId, followUpDateRange),

    // 5. Pipeline by stage for this rep (active deals only)
    () => tenantDb.execute(sql`
      SELECT
        d.stage_id,
        psc.name AS stage_name,
        psc.color AS stage_color,
        psc.display_order,
        COUNT(*) FILTER (WHERE ${aliasedActiveDealCountFilterSql("d")})::int AS deal_count,
        COALESCE(SUM(${dealValueSql()}), 0)::numeric AS total_value
      FROM deals d
      JOIN pipeline_stage_config psc ON psc.id = d.stage_id
      WHERE d.is_active = true
        AND ${aliasedActiveDealCountFilterSql("d")}
        AND ${buildAliasedDealMineVisibilityCondition("d", userId, {
          includeSubscriptions: mineVisibility.dealSubscriptions,
          includeCreatedBy: mineVisibility.dealsCreatedByUserId,
          includeSubscriptionDeletedAt: mineVisibility.dealSubscriptionsDeletedAt,
        })}
        AND ${nonTerminalDealStageSql()}
        AND psc.is_active_pipeline = true
      GROUP BY d.stage_id, psc.name, psc.color, psc.display_order
      ORDER BY psc.display_order ASC
    `),

    () => getStaleLeadWatchlist(tenantDb, {
      viewerUserId: userId,
      includeDealSubscriptions: mineVisibility.dealSubscriptions,
      includeLeadSubscriptions: mineVisibility.leadSubscriptions,
      includeDealCreatedBy: mineVisibility.dealsCreatedByUserId,
      includeLeadCreatedBy: mineVisibility.leadsCreatedByUserId,
      includeDealSubscriptionDeletedAt: mineVisibility.dealSubscriptionsDeletedAt,
      includeLeadSubscriptionDeletedAt: mineVisibility.leadSubscriptionsDeletedAt,
    }),
    () => getCrmOwnedProgression(tenantDb, {
      viewerUserId: userId,
      includeDealSubscriptions: mineVisibility.dealSubscriptions,
      includeLeadSubscriptions: mineVisibility.leadSubscriptions,
      includeDealCreatedBy: mineVisibility.dealsCreatedByUserId,
      includeLeadCreatedBy: mineVisibility.leadsCreatedByUserId,
      includeDealSubscriptionDeletedAt: mineVisibility.dealSubscriptionsDeletedAt,
      includeLeadSubscriptionDeletedAt: mineVisibility.leadSubscriptionsDeletedAt,
    }),
    () => getDownstreamBottlenecks(tenantDb, {
      viewerUserId: userId,
      viewerRole: "rep",
      includeDealSubscriptions: mineVisibility.dealSubscriptions,
      includeLeadSubscriptions: mineVisibility.leadSubscriptions,
      includeDealCreatedBy: mineVisibility.dealsCreatedByUserId,
      includeLeadCreatedBy: mineVisibility.leadsCreatedByUserId,
      includeDealSubscriptionDeletedAt: mineVisibility.dealSubscriptionsDeletedAt,
      includeLeadSubscriptionDeletedAt: mineVisibility.leadSubscriptionsDeletedAt,
    }),

    () => tenantDb.execute(sql`
      SELECT
        l.id AS lead_id,
        l.name AS lead_name,
        c.name AS company_name,
        p.name AS property_name,
        psc.slug AS stage_slug,
        psc.name AS stage_name,
        EXTRACT(DAY FROM NOW() - l.stage_entered_at)::int AS days_in_stage,
        l.updated_at
      FROM leads l
      LEFT JOIN companies c ON c.id = l.company_id
      LEFT JOIN properties p ON p.id = l.property_id
      JOIN pipeline_stage_config psc ON psc.id = l.stage_id
      WHERE l.is_active = true
        AND l.status = 'open'
        AND ${buildAliasedLeadMineVisibilityCondition("l", userId, {
          includeSubscriptions: mineVisibility.leadSubscriptions,
          includeCreatedBy: mineVisibility.leadsCreatedByUserId,
          includeSubscriptionDeletedAt: mineVisibility.leadSubscriptionsDeletedAt,
        })}
        AND NOT psc.is_terminal
      ORDER BY l.updated_at DESC
      LIMIT 5
    `),

    () => tenantDb.execute(sql`
      SELECT
        d.id AS deal_id,
        d.name AS deal_name,
        c.name AS company_name,
        p.name AS property_name,
        psc.slug AS stage_slug,
        COALESCE(d.bid_board_stage_slug, psc.slug) AS mirrored_stage_slug,
        d.workflow_route,
        psc.name AS stage_name,
        ${dealValueSql()}::numeric AS total_value,
        d.updated_at
      FROM deals d
      LEFT JOIN companies c ON c.id = d.company_id
      LEFT JOIN properties p ON p.id = d.property_id
      JOIN pipeline_stage_config psc ON psc.id = d.stage_id
      WHERE d.is_active = true
        AND ${buildAliasedDealMineVisibilityCondition("d", userId, {
          includeSubscriptions: mineVisibility.dealSubscriptions,
          includeCreatedBy: mineVisibility.dealsCreatedByUserId,
          includeSubscriptionDeletedAt: mineVisibility.dealSubscriptionsDeletedAt,
        })}
        AND ${nonTerminalDealStageSql()}
        AND ${aliasedActiveDealCountFilterSql("d")}
      ORDER BY d.updated_at DESC
      LIMIT 5
    `),
    () => getRepFunnelBuckets(tenantDb, {
      viewerUserId: userId,
      includeDealSubscriptions: mineVisibility.dealSubscriptions,
      includeLeadSubscriptions: mineVisibility.leadSubscriptions,
      includeDealCreatedBy: mineVisibility.dealsCreatedByUserId,
      includeLeadCreatedBy: mineVisibility.leadsCreatedByUserId,
      includeDealSubscriptionDeletedAt: mineVisibility.dealSubscriptionsDeletedAt,
      includeLeadSubscriptionDeletedAt: mineVisibility.leadSubscriptionsDeletedAt,
    }),
    () => getMyCleanupQueue(tenantDb, userId),
    () => getRepCommissionSummary(
      tenantDb,
      userId,
      commissionDateRange.from ?? activityRangeStartDate,
      commissionDateRange.to ?? today
    ),

    // Contracts signed YTD + MTD for this rep. Strict semantics: we count
    // signed contracts (contract_signed_at, falling back to contract_signed_date)
    // and sum awarded_amount only — a deal signed without an awarded_amount
    // contributes to count but not to totalValue, intentionally surfacing
    // data-quality issues rather than blending in bid/dd estimates. The today
    // guard rejects future-dated signing dates so misplaced future dates don't
    // pollute either window.
    () => tenantDb.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE COALESCE(contract_signed_at::date, contract_signed_date) >= ${yearStart}::date)::int AS ytd_count,
        COALESCE(SUM(awarded_amount) FILTER (WHERE COALESCE(contract_signed_at::date, contract_signed_date) >= ${yearStart}::date), 0)::numeric AS ytd_value,
        COUNT(*) FILTER (WHERE COALESCE(contract_signed_at::date, contract_signed_date) >= ${monthStart}::date)::int AS mtd_count,
        COALESCE(SUM(awarded_amount) FILTER (WHERE COALESCE(contract_signed_at::date, contract_signed_date) >= ${monthStart}::date), 0)::numeric AS mtd_value
      FROM deals
      WHERE assigned_rep_id = ${userId}
        AND (contract_signed_at IS NOT NULL OR contract_signed_date IS NOT NULL)
        AND COALESCE(contract_signed_at::date, contract_signed_date) <= ${today}::date
    `),
  ]);

  const alRows = (activeLeadResult as any).rows ?? activeLeadResult;
  const adRows = (activeDealResult as any).rows ?? activeDealResult;
  const tcRows = (taskCountResult as any).rows ?? taskCountResult;
  const acRows = (activityResult as any).rows ?? activityResult;
  const plRows = (pipelineResult as any).rows ?? pipelineResult;
  const lsRows = (leadSnapshotResult as any).rows ?? leadSnapshotResult;
  const dsRows = (dealSnapshotResult as any).rows ?? dealSnapshotResult;
  const csRows = (contractsSignedResult as any).rows ?? contractsSignedResult;
  const staleLeadAverage = staleLeadResult.length > 0
    ? Math.round(staleLeadResult.reduce((sum, lead) => sum + lead.daysInStage, 0) / staleLeadResult.length)
    : null;

  return {
    activeLeads: {
      count: Number(alRows[0]?.count ?? 0),
    },
    funnelBuckets,
    commissionSummary: commissionData.summary,
    commissionDeals: commissionData.deals,
    activeDeals: {
      count: Number(adRows[0]?.count ?? 0),
      totalValue: Number(adRows[0]?.total_value ?? 0),
    },
    contractsSignedYtd: {
      count: Number(csRows[0]?.ytd_count ?? 0),
      totalValue: Number(csRows[0]?.ytd_value ?? 0),
    },
    contractsSignedMtd: {
      count: Number(csRows[0]?.mtd_count ?? 0),
      totalValue: Number(csRows[0]?.mtd_value ?? 0),
    },
    tasksToday: {
      overdue: Number(tcRows[0]?.overdue ?? 0),
      today: Number(tcRows[0]?.today ?? 0),
    },
    // Field name legacy — see RepDashboardData declaration above.
    // Contents reflect the `range` parameter, not necessarily a week.
    activityThisWeek: {
      calls: Number(acRows[0]?.calls ?? 0),
      emails: Number(acRows[0]?.emails ?? 0),
      meetings: Number(acRows[0]?.meetings ?? 0),
      notes: Number(acRows[0]?.notes ?? 0),
      total: Number(acRows[0]?.total ?? 0),
    },
    followUpCompliance: complianceResult,
    pipelineByStage: plRows.map((r: any) => ({
      stageId: r.stage_id,
      stageName: r.stage_name,
      stageColor: r.stage_color,
      dealCount: Number(r.deal_count ?? 0),
      totalValue: Number(r.total_value ?? 0),
    })),
    staleLeads: {
      count: staleLeadResult.length,
      averageDaysInStage: staleLeadAverage,
      leads: staleLeadResult,
    },
    crmOwnedProgression,
    downstreamBottlenecks,
    leadSnapshot: lsRows.map((row: any) => ({
      leadId: row.lead_id,
      leadName: row.lead_name,
      companyName: row.company_name ?? null,
      propertyName: row.property_name ?? null,
      stageName: resolveLeadSnapshotStageLabel(row.stage_slug, row.stage_name),
      daysInStage: Number(row.days_in_stage ?? 0),
      updatedAt: toIsoOrNow(row.updated_at),
    })),
    dealSnapshot: dsRows.map((row: any) => ({
      dealId: row.deal_id,
      dealName: row.deal_name,
      companyName: row.company_name ?? null,
      propertyName: row.property_name ?? null,
      stageName: resolveDealSnapshotStageLabel(
        (row.workflow_route ?? "normal") as WorkflowRoute,
        row.stage_slug,
        row.mirrored_stage_slug,
        row.stage_name
      ),
      totalValue: Number(row.total_value ?? 0),
      updatedAt: toIsoOrNow(row.updated_at),
    })),
    myCleanup: {
      total: myCleanupResult.rows.length,
      byReason: myCleanupResult.byReason,
    },
  };
}

// ---------------------------------------------------------------------------
// Director Dashboard
// ---------------------------------------------------------------------------

export interface RepPerformanceCard {
  repId: string;
  repName: string;
  activeDeals: number;
  pipelineValue: number;
  winRate: number;
  activityScore: number; // total activities in period
  staleDeals: number;
  staleLeads: number;
}

export const REP_PERFORMANCE_PERIOD_KINDS = [
  "mtd",
  "qtd",
  "ytd",
  "last_month",
  "last_quarter",
  "last_year",
  "week_8back",
] as const;

export type RepPerformancePeriodKind = (typeof REP_PERFORMANCE_PERIOD_KINDS)[number];

export interface ForecastVsGoal {
  forecast: number;
  goal: number | null;
  goalSource: "none" | "manual" | "calculated";
  percentToGoal: number | null;
}

export interface RepPerformanceSnapshotRow {
  repId: string;
  repName: string;
  periodKind: RepPerformancePeriodKind;
  periodStart: string;
  periodEnd: string;
  pipelineValue: number;
  closedValue: number;
  dealsCount: number;
  winsCount: number;
  lossesCount: number;
  winRate: number;
  avgDaysToClose: number;
  atRiskCount: number;
  staleAccountCount: number;
  activityTotal: number;
  calls: number;
  emails: number;
  meetings: number;
  notes: number;
  sparkline8w: number[];
  region: string | null;
  computedAt: string;
  forecast: number;
  goal: number | null;
  goalSource: "none" | "manual" | "calculated";
  percentToGoal: number | null;
  forecastVsGoal: ForecastVsGoal;
  previous: RepPerformancePeriodMetrics | null;
}

export interface RepPerformancePeriodMetrics {
  pipelineValue: number;
  closedValue: number;
  dealsCount: number;
  winsCount: number;
  lossesCount: number;
  winRate: number;
  avgDaysToClose: number;
  atRiskCount: number;
  staleAccountCount: number;
  activityTotal: number;
  calls: number;
  emails: number;
  meetings: number;
  notes: number;
}

export interface RepPerformanceSnapshotsData {
  rows: RepPerformanceSnapshotRow[];
  forecastVsGoal: ForecastVsGoal;
}

export interface StrategicAlert {
  id: string;
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  repId?: string;
}

export interface AiCoachingPrompt {
  id: string;
  repId: string;
  repName: string;
  prompt: string;
  reason: string;
}

export interface RecentClose {
  dealId: string;
  dealNumber: string | null;
  dealName: string;
  repId: string | null;
  repName: string;
  outcome: "won" | "lost";
  dealValue: number;
  closedAt: string;
}

export interface DirectorDashboardData {
  officeFunnelBuckets: FunnelBucketSummary[];
  repFunnelRows: DirectorRepFunnelRow[];
  repCommissionRows: DirectorRepCommissionRow[];
  repCards: RepPerformanceCard[];
  pipelineByStage: Array<{
    stageId: string;
    stageName: string;
    stageColor: string | null;
    dealCount: number;
    totalValue: number;
  }>;
  winRateTrend: Array<{ month: string; wins: number; losses: number; winRate: number }>;
  activityByRep: Array<{
    repId: string;
    repName: string;
    calls: number;
    emails: number;
    meetings: number;
    notes: number;
    total: number;
  }>;
  staleDeals: Array<{
    dealId: string;
    dealNumber: string;
    dealName: string;
    stageName: string;
    repName: string;
    daysInStage: number;
    dealValue: number;
    workflowRoute?: "normal" | "service";
    bidBoardStageStatus?: string | null;
    regionClassification?: string | null;
    staleThresholdDays?: number;
  }>;
  staleLeads: StaleLeadDashboardRow[];
  crmOwnedProgression: DashboardCrmOwnedProgressionRow[];
  downstreamBottlenecks: DashboardDownstreamBottleneckRow[];
  atRiskDeals: DashboardAtRiskDealRow[];
  forecastVsGoal: ForecastVsGoal;
  activityPulse: Array<{
    repId: string;
    repName: string;
    calls: number;
    emails: number;
    meetings: number;
    notes: number;
    total: number;
  }>;
  strategicAlerts: StrategicAlert[];
  aiCoachingPrompts: AiCoachingPrompt[];
  recentCloses: RecentClose[];
  ddVsPipeline: {
    ddValue: number;
    ddCount: number;
    pipelineValue: number;
    pipelineCount: number;
    totalValue: number;
    totalCount: number;
  };
  scopeSummary?: {
    activePipeline: { count: number; totalValue: number };
    won: { count: number; totalValue: number };
    atRisk: { count: number; totalValue: number };
    stale: { count: number; totalValue: number };
  };
}

export interface DirectorCommissionWorkspaceRow {
  repId: string;
  repName: string;
  totalEarnedCommission: number;
  potentialCommission: number;
  floorRemaining: number;
  newCustomerShare: number;
  meetsNewCustomerShare: boolean;
  activeDeals: number;
  pipelineValue: number;
  leads: number;
  qualifiedLeads: number;
  opportunities: number;
  estimating: number;
  calls: number;
  emails: number;
  meetings: number;
  notes: number;
  totalActivities: number;
}

export interface DirectorCommissionWorkspaceData {
  rows: DirectorCommissionWorkspaceRow[];
}

async function getRepDealPipelineSummary(
  tenantDb: TenantDb
): Promise<Array<{ repId: string; activeDeals: number; pipelineValue: number }>> {
  const result = await tenantDb.execute(sql`
    SELECT
      d.assigned_rep_id AS rep_id,
      COUNT(*) FILTER (
        WHERE d.is_active = true
          AND COALESCE(d.is_test_data, false) = false
          AND d.contract_signed_at IS NULL
          AND d.contract_signed_date IS NULL
          AND ${aliasedActiveDealCountFilterSql("d")}
          AND psc.slug IN (${sql.join(COMMISSION_PIPELINE_STAGE_SLUGS.map((slug) => sql`${slug}`), sql`, `)})
      )::int AS active_deals,
      COALESCE(
        SUM(COALESCE(NULLIF(d.bid_board_total_sales, 0), NULLIF(d.bid_estimate, 0), NULLIF(d.dd_estimate, 0), d.awarded_amount, 0) + COALESCE(d.change_order_total, 0))
          FILTER (
            WHERE d.is_active = true
              AND COALESCE(d.is_test_data, false) = false
              AND d.contract_signed_at IS NULL
              AND d.contract_signed_date IS NULL
              AND ${aliasedActiveDealCountFilterSql("d")}
              AND psc.slug IN (${sql.join(COMMISSION_PIPELINE_STAGE_SLUGS.map((slug) => sql`${slug}`), sql`, `)})
          ),
        0
      )::numeric AS pipeline_value
    FROM ${deals} d
    JOIN ${pipelineStageConfig} psc ON psc.id = d.stage_id
    GROUP BY d.assigned_rep_id
  `);

  const rows = (result as any).rows ?? result;
  return rows.map((row: any) => ({
    repId: String(row.rep_id),
    activeDeals: Number(row.active_deals ?? 0),
    pipelineValue: Number(row.pipeline_value ?? 0),
  }));
}

export function dateOnly(value: unknown): string {
  if (!value) return "";
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

function normalizeSparkline(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => Number(entry ?? 0));
}

function buildGoalNullForecast(forecast: number): ForecastVsGoal {
  return {
    forecast,
    goal: null,
    goalSource: "none",
    percentToGoal: null,
  };
}

export async function getRepPerformanceSnapshots(
  tenantDb: TenantDb,
  officeId: string,
  periodKind: RepPerformancePeriodKind = "mtd"
): Promise<RepPerformanceSnapshotsData> {
  const result = await tenantDb.execute(sql`
    WITH current_snapshots AS (
      SELECT DISTINCT ON (rps.rep_id, rps.period_kind)
        rps.*,
        u.display_name AS rep_name
      FROM public.rep_performance_snapshots rps
      JOIN public.users u
        ON u.id = rps.rep_id
       AND u.is_active = true
       AND u.office_id = ${officeId}
      WHERE rps.period_kind = ${periodKind}
      ORDER BY rps.rep_id, rps.period_kind, rps.computed_at DESC NULLS LAST, rps.period_start DESC
    )
    SELECT
      current.rep_id,
      COALESCE(current.rep_name, 'Rep') AS rep_name,
      current.period_kind,
      current.period_start,
      current.period_end,
      current.pipeline_value::numeric AS pipeline_value,
      current.closed_value::numeric AS closed_value,
      current.deals_count::int AS deals_count,
      current.wins_count::int AS wins_count,
      current.losses_count::int AS losses_count,
      current.win_rate::numeric AS win_rate,
      current.avg_days_to_close::numeric AS avg_days_to_close,
      current.at_risk_count::int AS at_risk_count,
      current.stale_account_count::int AS stale_account_count,
      current.activity_total::int AS activity_total,
      current.calls::int AS calls,
      current.emails::int AS emails,
      current.meetings::int AS meetings,
      current.notes::int AS notes,
      current.sparkline_8w,
      current.region,
      current.computed_at,
      previous.pipeline_value::numeric AS previous_pipeline_value,
      previous.closed_value::numeric AS previous_closed_value,
      previous.deals_count::int AS previous_deals_count,
      previous.wins_count::int AS previous_wins_count,
      previous.losses_count::int AS previous_losses_count,
      previous.win_rate::numeric AS previous_win_rate,
      previous.avg_days_to_close::numeric AS previous_avg_days_to_close,
      previous.at_risk_count::int AS previous_at_risk_count,
      previous.stale_account_count::int AS previous_stale_account_count,
      previous.activity_total::int AS previous_activity_total,
      previous.calls::int AS previous_calls,
      previous.emails::int AS previous_emails,
      previous.meetings::int AS previous_meetings,
      previous.notes::int AS previous_notes
    FROM current_snapshots current
    LEFT JOIN LATERAL (
      SELECT prior.*
      FROM public.rep_performance_snapshots prior
      WHERE prior.rep_id = current.rep_id
        AND prior.period_kind = current.period_kind
        AND prior.period_start = (
          CASE
            WHEN current.period_kind IN ('mtd', 'last_month') THEN current.period_start - INTERVAL '1 month'
            WHEN current.period_kind IN ('qtd', 'last_quarter') THEN current.period_start - INTERVAL '3 months'
            WHEN current.period_kind IN ('ytd', 'last_year') THEN current.period_start - INTERVAL '1 year'
            WHEN current.period_kind = 'week_8back' THEN current.period_start - INTERVAL '56 days'
            ELSE NULL
          END
        )::date
        AND prior.period_end = (
          CASE
            WHEN current.period_kind = 'mtd' THEN current.period_end - INTERVAL '1 month'
            WHEN current.period_kind = 'qtd' THEN current.period_end - INTERVAL '3 months'
            WHEN current.period_kind = 'ytd' THEN current.period_end - INTERVAL '1 year'
            WHEN current.period_kind = 'last_month' THEN date_trunc('month', current.period_end)::date - INTERVAL '1 day'
            WHEN current.period_kind = 'last_quarter' THEN date_trunc('quarter', current.period_end)::date - INTERVAL '1 day'
            WHEN current.period_kind = 'last_year' THEN date_trunc('year', current.period_end)::date - INTERVAL '1 day'
            WHEN current.period_kind = 'week_8back' THEN current.period_end - INTERVAL '56 days'
            ELSE NULL
          END
        )::date
    ) previous ON true
    ORDER BY current.rep_id, current.period_kind
  `);

  const rows = rowsFromExecute<any>(result).map((row) => {
    const forecast = Number(row.pipeline_value ?? 0);
    const forecastVsGoal = buildGoalNullForecast(forecast);
    const previous = row.previous_closed_value === null || row.previous_closed_value === undefined
      ? null
      : {
          pipelineValue: Number(row.previous_pipeline_value ?? 0),
          closedValue: Number(row.previous_closed_value ?? 0),
          dealsCount: Number(row.previous_deals_count ?? 0),
          winsCount: Number(row.previous_wins_count ?? 0),
          lossesCount: Number(row.previous_losses_count ?? 0),
          winRate: Number(row.previous_win_rate ?? 0),
          avgDaysToClose: Number(row.previous_avg_days_to_close ?? 0),
          atRiskCount: Number(row.previous_at_risk_count ?? 0),
          staleAccountCount: Number(row.previous_stale_account_count ?? 0),
          activityTotal: Number(row.previous_activity_total ?? 0),
          calls: Number(row.previous_calls ?? 0),
          emails: Number(row.previous_emails ?? 0),
          meetings: Number(row.previous_meetings ?? 0),
          notes: Number(row.previous_notes ?? 0),
        };

    return {
      repId: String(row.rep_id),
      repName: String(row.rep_name ?? "Rep"),
      periodKind: row.period_kind as RepPerformancePeriodKind,
      periodStart: dateOnly(row.period_start),
      periodEnd: dateOnly(row.period_end),
      pipelineValue: forecast,
      closedValue: Number(row.closed_value ?? 0),
      dealsCount: Number(row.deals_count ?? 0),
      winsCount: Number(row.wins_count ?? 0),
      lossesCount: Number(row.losses_count ?? 0),
      winRate: Number(row.win_rate ?? 0),
      avgDaysToClose: Number(row.avg_days_to_close ?? 0),
      atRiskCount: Number(row.at_risk_count ?? 0),
      staleAccountCount: Number(row.stale_account_count ?? 0),
      activityTotal: Number(row.activity_total ?? 0),
      calls: Number(row.calls ?? 0),
      emails: Number(row.emails ?? 0),
      meetings: Number(row.meetings ?? 0),
      notes: Number(row.notes ?? 0),
      sparkline8w: normalizeSparkline(row.sparkline_8w),
      region: row.region ? String(row.region) : null,
      computedAt: toIsoOrNow(row.computed_at),
      forecast,
      goal: forecastVsGoal.goal,
      goalSource: forecastVsGoal.goalSource,
      percentToGoal: forecastVsGoal.percentToGoal,
      forecastVsGoal,
      previous,
    };
  });

  return {
    rows,
    forecastVsGoal: buildGoalNullForecast(rows.reduce((sum, row) => sum + row.forecast, 0)),
  };
}

function buildStrategicAlerts(
  snapshots: RepPerformanceSnapshotRow[],
  bottlenecks: DashboardDownstreamBottleneckRow[],
  atRiskCountsByRep: Map<string, number> = new Map()
): StrategicAlert[] {
  const alerts: StrategicAlert[] = [];

  for (const row of snapshots) {
    const atRiskCount = atRiskCountsByRep.get(row.repId) ?? 0;
    if (atRiskCount > 0) {
      alerts.push({
        id: `at-risk-${row.repId}`,
        severity: atRiskCount >= 3 ? "critical" : "warning",
        title: "At-risk pipeline",
        detail: `${row.repName} has ${atRiskCount} at-risk deal${atRiskCount === 1 ? "" : "s"}.`,
        repId: row.repId,
      });
    }

    if ((row.winsCount + row.lossesCount) > 0 && row.winRate < 25) {
      alerts.push({
        id: `win-rate-${row.repId}`,
        severity: "warning",
        title: "Low win rate",
        detail: `${row.repName} is tracking a ${row.winRate}% win rate for this period.`,
        repId: row.repId,
      });
    }
  }

  if (bottlenecks.length > 0) {
    alerts.push({
      id: "downstream-bottlenecks",
      severity: "info",
      title: "Downstream bottlenecks",
      detail: `${bottlenecks.length} downstream item${bottlenecks.length === 1 ? "" : "s"} need director review.`,
    });
  }

  return alerts.slice(0, 8);
}

function buildAiCoachingPrompts(snapshots: RepPerformanceSnapshotRow[]): AiCoachingPrompt[] {
  return snapshots
    .filter((row) => row.pipelineValue > 0 && (row.winRate < 30 || row.activityTotal < 5 || row.atRiskCount > 0))
    .slice(0, 8)
    .map((row) => ({
      id: `coaching-${row.repId}`,
      repId: row.repId,
      repName: row.repName,
      prompt: `Review ${row.repName}'s current pipeline and next-step coverage.`,
      reason:
        row.atRiskCount > 0
          ? "At-risk deals are present in the snapshot."
          : row.winRate < 30
            ? "Win rate is below the director review threshold."
            : "Activity volume is below the expected review threshold.",
    }));
}

function buildAtRiskCountsByRep(deals: DashboardAtRiskDealRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const deal of deals) {
    if (!deal.repId) continue;
    counts.set(deal.repId, (counts.get(deal.repId) ?? 0) + 1);
  }
  return counts;
}

async function getRecentCloses(
  tenantDb: TenantDb,
  options: { from: string; to: string } & DashboardScopeOptions
): Promise<RecentClose[]> {
  const repFilter = dealScopeFilterSql("d", options);
  const result = await tenantDb.execute(sql`
    SELECT
      d.id AS deal_id,
      d.deal_number,
      d.name AS deal_name,
      d.assigned_rep_id AS rep_id,
      COALESCE(u.display_name, 'Unassigned') AS rep_name,
      CASE
        WHEN psc.slug IN (${sql.join([...WON_STAGE_SLUGS, ...LEGACY_WON_STAGE_SLUGS].map((slug) => sql`${slug}`), sql`, `)}) THEN 'won'
        ELSE 'lost'
      END AS outcome,
      ${recentCloseDealValueSql()}::numeric AS deal_value,
      COALESCE(d.actual_close_date, d.contract_signed_date, d.contract_signed_at::date, d.lost_at::date, d.updated_at::date) AS closed_at
    FROM ${deals} d
    JOIN ${pipelineStageConfig} psc ON psc.id = d.stage_id
    LEFT JOIN ${users} u ON u.id = d.assigned_rep_id
    WHERE d.is_active = true
      AND ${aliasedActiveDealCountFilterSql("d")}
      AND psc.slug IN (${sql.join([...WON_STAGE_SLUGS, ...LEGACY_WON_STAGE_SLUGS, ...LOST_STAGE_SLUGS, ...LEGACY_LOST_STAGE_SLUGS].map((slug) => sql`${slug}`), sql`, `)})
      AND COALESCE(d.actual_close_date, d.contract_signed_date, d.contract_signed_at::date, d.lost_at::date, d.updated_at::date) >= ${options.from}::date
      AND COALESCE(d.actual_close_date, d.contract_signed_date, d.contract_signed_at::date, d.lost_at::date, d.updated_at::date) <= ${options.to}::date
      ${repFilter}
    ORDER BY closed_at DESC NULLS LAST, d.name ASC
    LIMIT 12
  `);

  return rowsFromExecute<any>(result).map((row) => ({
    dealId: String(row.deal_id),
    dealNumber: row.deal_number ? String(row.deal_number) : null,
    dealName: String(row.deal_name ?? "Deal"),
    repId: row.rep_id ? String(row.rep_id) : null,
    repName: String(row.rep_name ?? "Unassigned"),
    outcome: row.outcome === "won" ? "won" : "lost",
    dealValue: Number(row.deal_value ?? 0),
    closedAt: dateOnly(row.closed_at),
  }));
}

async function getWonCloseSummary(
  tenantDb: TenantDb,
  options: { from: string; to: string } & DashboardScopeOptions
): Promise<{ count: number; totalValue: number }> {
  const repFilter = dealScopeFilterSql("d", options);
  const result = await tenantDb.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE ${aliasedActiveDealCountFilterSql("d")})::int AS won_count,
      COALESCE(SUM(${aliasedEffectiveAwardedDealValueSql("d")}), 0)::numeric AS won_value
    FROM ${deals} d
    JOIN ${pipelineStageConfig} psc ON psc.id = d.stage_id
    WHERE d.is_active = true
      AND ${aliasedActiveDealCountFilterSql("d")}
      AND psc.slug IN (${sql.join([...WON_STAGE_SLUGS, ...LEGACY_WON_STAGE_SLUGS].map((slug) => sql`${slug}`), sql`, `)})
      AND COALESCE(d.actual_close_date, d.contract_signed_date, d.contract_signed_at::date, d.updated_at::date) >= ${options.from}::date
      AND COALESCE(d.actual_close_date, d.contract_signed_date, d.contract_signed_at::date, d.updated_at::date) <= ${options.to}::date
      ${repFilter}
  `);

  const [row] = rowsFromExecute<any>(result);
  return {
    count: Number(row?.won_count ?? 0),
    totalValue: Number(row?.won_value ?? 0),
  };
}

async function getScopedPipelineSummary(
  tenantDb: TenantDb,
  options: { includeDd?: boolean } & DashboardScopeOptions = {}
): Promise<PipelineSummaryRow[]> {
  const includeDd = options.includeDd ?? false;
  const stages = await db
    .select()
    .from(pipelineStageConfig)
    .where(eq(pipelineStageConfig.isTerminal, false))
    .orderBy(asc(pipelineStageConfig.displayOrder));

  const filteredStages = includeDd ? stages : stages.filter((s) => s.isActivePipeline);
  const stageIds = filteredStages.map((s) => s.id);
  if (stageIds.length === 0) return [];

  const scopeFilter = dealScopeFilterSql("d", options);
  const result = await tenantDb.execute(sql`
    SELECT
      d.stage_id,
      COUNT(*) FILTER (WHERE ${aliasedActiveDealCountFilterSql("d")})::int AS deal_count,
      COALESCE(SUM(${dealValueSql()}), 0)::numeric AS total_value
    FROM deals d
    WHERE d.is_active = true
      AND COALESCE(d.is_test_data, false) = false
      AND ${aliasedActiveDealCountFilterSql("d")}
      AND d.stage_id IN (${sql.join(stageIds.map((id) => sql`${id}`), sql`, `)})
      AND COALESCE(d.bid_board_stage_slug, '') NOT IN (${sqlSlugList(TERMINAL_STAGE_SLUGS)})
      ${scopeFilter}
    GROUP BY d.stage_id
  `);

  const rows = rowsFromExecute<any>(result);
  const dataMap = new Map<string, { dealCount: number; totalValue: number }>();
  for (const row of rows) {
    dataMap.set(String(row.stage_id), {
      dealCount: Number(row.deal_count ?? 0),
      totalValue: Number(row.total_value ?? 0),
    });
  }

  return filteredStages.map((stage) => ({
    stageId: stage.id,
    stageName: stage.name,
    stageColor: stage.color,
    displayOrder: stage.displayOrder,
    isActivePipeline: stage.isActivePipeline,
    dealCount: dataMap.get(stage.id)?.dealCount ?? 0,
    totalValue: dataMap.get(stage.id)?.totalValue ?? 0,
  }));
}

async function getDashboardStaleDeals(
  tenantDb: TenantDb,
  options: DashboardScopeOptions = {}
): Promise<StaleDealRow[]> {
  const rows = await getDashboardAtRiskRows(tenantDb, options);
  return buildDashboardAtRiskStaleDeals(rows, options.viewerRole ?? "rep");
}

async function getDashboardAtRiskRows(
  tenantDb: TenantDb,
  options: DashboardScopeOptions = {}
): Promise<DashboardAtRiskSummaryRow[]> {
  const scopeFilter = dealScopeFilterSql("d", options);
  const result = await tenantDb.execute(sql`
    SELECT
      d.id AS deal_id,
      d.deal_number,
      d.stage_id,
      d.assigned_rep_id AS rep_id,
      COALESCE(u.display_name, 'Unassigned') AS rep_name,
      d.name AS deal_name,
      ${dealValueSql()}::numeric AS deal_value,
      COALESCE(d.bid_board_stage_slug, psc.slug) AS stage_slug,
      psc.name AS stage_name,
      d.bid_board_stage_status AS mirrored_stage_status,
      d.workflow_route,
      COALESCE(NULLIF(TRIM(d.region_classification), ''), TRIM(CONCAT_WS(', ', d.property_city, d.property_state)), 'Unassigned region') AS region_classification,
      COALESCE(d.bid_board_stage_entered_at, d.stage_entered_at, latest_current_stage_entered_at.entered_at) AS stage_entered_at,
      d.on_hold,
      d.on_hold_started_at,
      d.on_hold_accumulated_seconds,
      d.on_hold_accumulated_seconds_at_stage_entry
    FROM deals d
    JOIN pipeline_stage_config psc ON psc.id = d.stage_id
    LEFT JOIN users u ON u.id = d.assigned_rep_id
    LEFT JOIN LATERAL (
      SELECT MAX(dsh.created_at) AS entered_at
      FROM deal_stage_history dsh
      WHERE dsh.deal_id = d.id
        AND dsh.to_stage_id = d.stage_id
    ) latest_current_stage_entered_at ON true
    WHERE d.is_active = true
      AND COALESCE(d.is_test_data, false) = false
      AND ${aliasedActiveDealCountFilterSql("d")}
      AND ${nonTerminalDealStageSql()}
      ${scopeFilter}
  `);

  return rowsFromExecute<any>(result).map((row) => ({
    dealId: row.deal_id ? String(row.deal_id) : null,
    dealNumber: row.deal_number ? String(row.deal_number) : null,
    stageId: row.stage_id ? String(row.stage_id) : null,
    repId: row.rep_id ? String(row.rep_id) : null,
    repName: row.rep_name ? String(row.rep_name) : null,
    dealName: row.deal_name ? String(row.deal_name) : null,
    dealValue: Number(row.deal_value ?? 0),
    stageSlug: row.stage_slug ? String(row.stage_slug) : null,
    stageName: resolveMirroredStageLabel(row.stage_slug, row.stage_name),
    mirroredStageStatus: row.mirrored_stage_status ?? null,
    regionClassification: row.region_classification ?? null,
    workflowRoute: (row.workflow_route ?? "normal") as WorkflowRoute,
    stageEnteredAt: row.stage_entered_at ?? null,
    onHold: Boolean(row.on_hold),
    onHoldStartedAt: row.on_hold_started_at ?? null,
    onHoldAccumulatedSeconds: row.on_hold_accumulated_seconds ?? 0,
    onHoldAccumulatedSecondsAtStageEntry: row.on_hold_accumulated_seconds_at_stage_entry ?? 0,
  }));
}

async function buildDirectorScopeSummary(
  tenantDb: TenantDb,
  options: { from: string; to: string } & DashboardScopeOptions
) {
  const [pipelineRows, staleDeals, atRiskRows, won] = await runSequential([
    () => getScopedPipelineSummary(tenantDb, {
      includeDd: false,
      repId: options.repId,
      viewerUserId: options.viewerUserId,
      includeDealSubscriptions: options.includeDealSubscriptions,
      includeDealCreatedBy: options.includeDealCreatedBy,
      includeDealSubscriptionDeletedAt: options.includeDealSubscriptionDeletedAt,
    }),
    () => getDashboardStaleDeals(
      tenantDb,
      options.repId || options.viewerUserId
        ? {
            repId: options.repId,
            viewerUserId: options.viewerUserId,
            includeDealSubscriptions: options.includeDealSubscriptions,
            includeDealCreatedBy: options.includeDealCreatedBy,
            includeDealSubscriptionDeletedAt: options.includeDealSubscriptionDeletedAt,
          }
        : {}
    ),
    () => getDashboardAtRiskRows(
      tenantDb,
      options.repId || options.viewerUserId
        ? {
            repId: options.repId,
            viewerUserId: options.viewerUserId,
            includeDealSubscriptions: options.includeDealSubscriptions,
            includeDealCreatedBy: options.includeDealCreatedBy,
            includeDealSubscriptionDeletedAt: options.includeDealSubscriptionDeletedAt,
          }
        : {}
    ),
    () => getWonCloseSummary(tenantDb, options),
  ]);

  const activePipeline = pipelineRows.reduce(
    (acc, row) => ({
      count: acc.count + row.dealCount,
      totalValue: acc.totalValue + row.totalValue,
    }),
    { count: 0, totalValue: 0 }
  );
  const atRisk = buildDashboardAtRiskSummary(atRiskRows, options.viewerRole ?? "director");
  const stale = staleDeals.reduce(
    (acc, deal) => ({
      count: acc.count + 1,
      totalValue: acc.totalValue + deal.dealValue,
    }),
    { count: 0, totalValue: 0 }
  );

  return { activePipeline, won, atRisk, stale };
}

export async function getDirectorCommissionWorkspace(
  tenantDb: TenantDb,
  options: { from?: string; to?: string } = {}
): Promise<DirectorCommissionWorkspaceData> {
  const year = new Date().getUTCFullYear();
  const from = options.from ?? `${year}-01-01`;
  const to = options.to ?? `${year}-12-31`;

  const [commissionRows, activityRows, funnelSummary, dealSummaryRows] = await runSequential([
    () => getDirectorRepCommissionRows(tenantDb, { from, to }),
    () => getActivitySummaryByRep(tenantDb, { from, to }),
    () => getDirectorFunnelSummary(tenantDb),
    () => getRepDealPipelineSummary(tenantDb),
  ]);

  const activityByRep = new Map(activityRows.map((row) => [row.repId, row]));
  const funnelByRep = new Map(funnelSummary.repFunnelRows.map((row) => [row.repId, row]));
  const dealSummaryByRep = new Map(dealSummaryRows.map((row) => [row.repId, row]));

  const rows = commissionRows.map((row) => {
    const activity = activityByRep.get(row.repId);
    const funnel = funnelByRep.get(row.repId);
    const dealSummary = dealSummaryByRep.get(row.repId);

    return {
      repId: row.repId,
      repName: row.repName,
      totalEarnedCommission: row.totalEarnedCommission,
      potentialCommission: row.potentialCommission,
      floorRemaining: row.floorRemaining,
      newCustomerShare: row.newCustomerShare,
      meetsNewCustomerShare: row.meetsNewCustomerShare,
      activeDeals: dealSummary?.activeDeals ?? 0,
      pipelineValue: dealSummary?.pipelineValue ?? 0,
      leads: funnel?.leads ?? 0,
      qualifiedLeads: funnel?.qualifiedLeads ?? 0,
      opportunities: funnel?.opportunities ?? 0,
      estimating: funnel?.estimating ?? 0,
      calls: activity?.calls ?? 0,
      emails: activity?.emails ?? 0,
      meetings: activity?.meetings ?? 0,
      notes: activity?.notes ?? 0,
      totalActivities: activity?.total ?? 0,
    };
  });

  return { rows };
}

/**
 * Aggregate all data for the director dashboard.
 * Queries run sequentially because tenantDb is bound to a single client per request.
 */
export async function getDirectorDashboard(
  tenantDb: TenantDb,
  options: {
    from?: string;
    to?: string;
    officeId: string;
    periodKind?: RepPerformancePeriodKind;
    scope?: "mine" | "all";
    viewerUserId?: string;
    viewerRole?: string;
  }
): Promise<DirectorDashboardData> {
  const year = new Date().getFullYear();
  const from = options.from ?? `${year}-01-01`;
  const to = options.to ?? `${year}-12-31`;
  const now = new Date();
  const scopedViewerUserId = options.scope === "mine" ? options.viewerUserId : undefined;
  const mineVisibility = scopedViewerUserId ? await resolveMineVisibilityFeatures(tenantDb) : null;

  const [
    repCardsResult,
    pipelineResult,
    winRateTrendResult,
    activityResult,
    staleLeadResult,
    ddResult,
    crmOwnedProgression,
    atRiskRows,
    funnelSummary,
    repCommissionRows,
    repPerformanceSnapshots,
    recentCloses,
    scopeSummary,
  ] = await runSequential([
    // 1. Per-rep performance cards
    () => buildRepPerformanceCards(tenantDb, { from, to }),

    // 2. Pipeline by stage (company-wide, excluding DD)
    () => getPipelineSummary(tenantDb, { includeDd: false, from, to }),

    // 3. Win rate trend
    () => getWinRateTrend(tenantDb, { from, to }),

    // 4. Activity by rep
    () => getActivitySummaryByRep(tenantDb, { from, to }),

    // 5. Stale leads watchlist
    () => getStaleLeadWatchlist(tenantDb),

    // 6. DD vs pipeline
    () => getDdVsPipeline(tenantDb),
    () => getCrmOwnedProgression(tenantDb),
    () => getDashboardAtRiskRows(tenantDb, {
      viewerUserId: scopedViewerUserId,
      viewerRole: options.viewerRole ?? "director",
      includeDealSubscriptions: mineVisibility?.dealSubscriptions,
      includeDealCreatedBy: mineVisibility?.dealsCreatedByUserId,
      includeDealSubscriptionDeletedAt: mineVisibility?.dealSubscriptionsDeletedAt,
    }),
    () => getDirectorFunnelSummary(tenantDb),
    () => getDirectorRepCommissionRows(tenantDb, { from, to }),
    () => getRepPerformanceSnapshots(tenantDb, options.officeId, options.periodKind ?? "mtd"),
    () => getRecentCloses(tenantDb, { from, to }),
    () => buildDirectorScopeSummary(tenantDb, {
      from,
      to,
      viewerUserId: scopedViewerUserId,
      viewerRole: options.viewerRole,
      includeDealSubscriptions: mineVisibility?.dealSubscriptions,
      includeLeadSubscriptions: mineVisibility?.leadSubscriptions,
      includeDealCreatedBy: mineVisibility?.dealsCreatedByUserId,
      includeLeadCreatedBy: mineVisibility?.leadsCreatedByUserId,
      includeDealSubscriptionDeletedAt: mineVisibility?.dealSubscriptionsDeletedAt,
      includeLeadSubscriptionDeletedAt: mineVisibility?.leadSubscriptionsDeletedAt,
    }),
  ]);

  const dashboardStaleDeals = buildDashboardAtRiskStaleDeals(
    atRiskRows,
    options.viewerRole ?? "director",
    now
  );
  const dashboardAtRiskDeals = buildDashboardAtRiskDeals(
    atRiskRows,
    options.viewerRole ?? "director",
    now
  );
  const dashboardDownstreamBottlenecks = buildDashboardDownstreamBottlenecks(
    atRiskRows,
    options.viewerRole ?? "director",
    now
  );
  const atRiskScopeSummary = buildDashboardAtRiskSummary(
    atRiskRows,
    options.viewerRole ?? "director",
    now
  );
  const atRiskCountsByRep = buildAtRiskCountsByRep(dashboardAtRiskDeals);
  const repCards = repCardsResult.map((rep) => ({
    ...rep,
    staleDeals: atRiskCountsByRep.get(rep.repId) ?? 0,
  }));

  return {
    officeFunnelBuckets: funnelSummary.officeFunnelBuckets,
    repFunnelRows: funnelSummary.repFunnelRows,
    repCommissionRows,
    repCards,
    pipelineByStage: pipelineResult.map((s) => ({
      stageId: s.stageId,
      stageName: s.stageName,
      stageColor: s.stageColor,
      dealCount: s.dealCount,
      totalValue: s.totalValue,
    })),
    winRateTrend: winRateTrendResult,
    activityByRep: activityResult.map((a) => ({
      repId: a.repId,
      repName: a.repName,
      calls: a.calls,
      emails: a.emails,
      meetings: a.meetings,
      notes: a.notes,
      total: a.total,
    })),
    staleDeals: dashboardStaleDeals.map((s) => ({
      dealId: s.dealId,
      dealNumber: s.dealNumber,
      dealName: s.dealName,
      stageName: s.stageName,
      repName: s.repName,
      daysInStage: s.daysInStage,
      dealValue: s.dealValue,
      workflowRoute: s.workflowRoute,
      bidBoardStageStatus: s.bidBoardStageStatus ?? null,
      regionClassification: s.regionClassification ?? null,
      staleThresholdDays: s.staleThresholdDays,
    })),
    staleLeads: staleLeadResult,
    crmOwnedProgression,
    downstreamBottlenecks: dashboardDownstreamBottlenecks,
    atRiskDeals: dashboardAtRiskDeals,
    forecastVsGoal: repPerformanceSnapshots.forecastVsGoal,
    activityPulse: repPerformanceSnapshots.rows.map((row) => ({
      repId: row.repId,
      repName: row.repName,
      calls: row.calls,
      emails: row.emails,
      meetings: row.meetings,
      notes: row.notes,
      total: row.activityTotal,
    })),
    strategicAlerts: buildStrategicAlerts(
      repPerformanceSnapshots.rows,
      dashboardDownstreamBottlenecks,
      atRiskCountsByRep
    ),
    aiCoachingPrompts: buildAiCoachingPrompts(repPerformanceSnapshots.rows),
    recentCloses,
    ddVsPipeline: ddResult,
    scopeSummary: {
      ...scopeSummary,
      atRisk: atRiskScopeSummary,
      stale: atRiskScopeSummary,
    },
  };
}

/**
 * Build rep performance cards: for each active rep, aggregate deal count, pipeline value,
 * win rate, activity score, and stale deal count.
 */
async function buildRepPerformanceCards(
  tenantDb: TenantDb,
  options: { from: string; to: string }
): Promise<RepPerformanceCard[]> {
  const { from, to } = options;

  const result = await tenantDb.execute(sql`
    WITH deal_owners AS (
      -- Locked requirement: keep all active reps, and also include non-reps who
      -- have ever owned at least one deal so their row appears on the dashboard.
      SELECT DISTINCT d.assigned_rep_id AS rep_id
      FROM deals d
      WHERE d.assigned_rep_id IS NOT NULL
    ),
    rep_deals AS (
      SELECT
        d.assigned_rep_id AS rep_id,
        COUNT(*) FILTER (WHERE d.is_active AND ${nonTerminalDealStageSql()} AND ${aliasedActiveDealCountFilterSql("d")})::int AS active_deals,
        COALESCE(SUM(${dealValueSql()}) FILTER (WHERE d.is_active AND ${nonTerminalDealStageSql()} AND psc.is_active_pipeline AND ${aliasedActiveDealCountFilterSql("d")}), 0)::numeric AS pipeline_value
      FROM deals d
      JOIN pipeline_stage_config psc ON psc.id = d.stage_id
      GROUP BY d.assigned_rep_id
    ),
    rep_wins AS (
      SELECT
        d.assigned_rep_id AS rep_id,
        COUNT(*) FILTER (
          WHERE psc.slug IN (${sql.join([...WON_STAGE_SLUGS, ...LEGACY_WON_STAGE_SLUGS].map((slug) => sql`${slug}`), sql`, `)})
            AND ${aliasedActiveDealCountFilterSql("d")}
        )::int AS wins,
        COUNT(*) FILTER (
          WHERE psc.slug IN (${sql.join([...LOST_STAGE_SLUGS, ...LEGACY_LOST_STAGE_SLUGS].map((slug) => sql`${slug}`), sql`, `)})
            AND ${aliasedActiveDealCountFilterSql("d")}
        )::int AS losses
      FROM deal_stage_history dsh
      JOIN deals d ON d.id = dsh.deal_id
      JOIN pipeline_stage_config psc ON psc.id = dsh.to_stage_id
      WHERE psc.is_terminal = true
        AND dsh.created_at >= ${from}::timestamptz
        AND dsh.created_at <= (${to}::date + INTERVAL '1 day')::timestamptz
      GROUP BY d.assigned_rep_id
    ),
    rep_activities AS (
      SELECT
        a.responsible_user_id AS rep_id,
        COUNT(*)::int AS total
      FROM activities a
      WHERE a.occurred_at >= ${from}::timestamptz
        AND a.occurred_at <= (${to}::date + INTERVAL '1 day')::timestamptz
      GROUP BY a.responsible_user_id
    )
    SELECT
      u.id AS rep_id,
      u.display_name AS rep_name,
      COALESCE(rd.active_deals, 0)::int AS active_deals,
      COALESCE(rd.pipeline_value, 0)::numeric AS pipeline_value,
      COALESCE(rw.wins, 0)::int AS wins,
      COALESCE(rw.losses, 0)::int AS losses,
      COALESCE(ra.total, 0)::int AS activity_score
    FROM users u
    LEFT JOIN deal_owners owner_rows ON owner_rows.rep_id = u.id
    LEFT JOIN rep_deals rd ON rd.rep_id = u.id
    LEFT JOIN rep_wins rw ON rw.rep_id = u.id
    LEFT JOIN rep_activities ra ON ra.rep_id = u.id
    WHERE u.is_active = true
      AND (u.role = 'rep' OR owner_rows.rep_id IS NOT NULL)
    ORDER BY pipeline_value DESC
  `);
  const staleLeadCounts = await getStaleLeadCountsByRep(tenantDb);

  const rows = (result as any).rows ?? result;
  return rows.map((r: any) => {
    const wins = Number(r.wins ?? 0);
    const losses = Number(r.losses ?? 0);
    const total = wins + losses;
    return {
      repId: r.rep_id,
      repName: r.rep_name,
      activeDeals: Number(r.active_deals ?? 0),
      pipelineValue: Number(r.pipeline_value ?? 0),
      winRate: total > 0 ? Math.round((wins / total) * 100) : 0,
      activityScore: Number(r.activity_score ?? 0),
      staleDeals: 0,
      staleLeads: staleLeadCounts.get(r.rep_id) ?? 0,
    };
  });
}

async function getStaleLeadCountsByRep(tenantDb: TenantDb): Promise<Map<string, number>> {
  const result = await tenantDb.execute<{
    rep_id: string | null;
    stage_entered_at: string | Date | null;
    pipeline_type: "normal" | "service" | null;
  }>(sql`
    SELECT
      l.assigned_rep_id AS rep_id,
      l.stage_entered_at,
      l.pipeline_type
    FROM leads l
    JOIN pipeline_stage_config psc ON psc.id = l.stage_id
    JOIN companies c ON c.id = l.company_id
    JOIN properties p ON p.id = l.property_id
    JOIN users u ON u.id = l.assigned_rep_id
    WHERE l.is_active = true
      AND l.status = 'open'
      AND psc.workflow_family = 'lead'
      AND psc.is_terminal = false
  `);
  const counts = new Map<string, number>();
  const now = new Date();
  for (const row of rowsFromExecute(result)) {
    if (!row.rep_id) continue;
    if (!getLeadStaleAtRiskResult(row.stage_entered_at, row.pipeline_type, now).isAtRisk) continue;
    counts.set(row.rep_id, (counts.get(row.rep_id) ?? 0) + 1);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Director Drill-Down (single rep detail)
// ---------------------------------------------------------------------------

function formatUtcDate(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function getRollingCommissionDateRange(anchorDate: string): { from: string; to: string } {
  const [year, month, day] = anchorDate.split("-").map(Number);
  const previousYearLastDayOfMonth = new Date(Date.UTC(year! - 1, month!, 0)).getUTCDate();
  const previousYearSameOrClampedDay = new Date(
    Date.UTC(year! - 1, month! - 1, Math.min(day!, previousYearLastDayOfMonth))
  );
  const rollingStart = new Date(previousYearSameOrClampedDay);
  rollingStart.setUTCDate(rollingStart.getUTCDate() + 1);
  return {
    from: formatUtcDate(rollingStart),
    to: anchorDate,
  };
}

/**
 * Get full dashboard data for a single rep -- used by director drill-down.
 * Returns the same shape as RepDashboardData plus win/loss stats.
 */
export async function getRepDetail(
  tenantDb: TenantDb,
  repId: string,
  options: { from?: string; to?: string } = {}
) {
  const year = new Date().getFullYear();
  const from = options.from ?? `${year}-01-01`;
  const to = options.to ?? `${year}-12-31`;
  const rollingCommissionDateRange = getRollingCommissionDateRange(to);

  const [dashboard, winLoss, winTrend, staleDeals, staleLeads] = await runSequential([
    () => getRepDashboard(tenantDb, repId, {
      activityDateRange: { from, to },
      followUpDateRange: { from, to },
      commissionDateRange: rollingCommissionDateRange,
    }),
    () => getWinLossRatioByRep(tenantDb, { from, to }),
    () => getWinRateTrend(tenantDb, { from, to, repId }),
    () => getDashboardStaleDeals(tenantDb, { repId, viewerRole: "rep" }),
    () => getStaleLeadWatchlist(tenantDb, { repId }),
  ]);

  const repWinLoss = winLoss.find((w) => w.repId === repId) ?? {
    repId,
    repName: "",
    wins: 0,
    losses: 0,
    winRate: 0,
    totalValue: 0,
  };

  return {
    ...dashboard,
    winLoss: repWinLoss,
    winRateTrend: winTrend,
    staleDeals,
    staleLeads,
  };
}

export interface AdminDashboardSummary {
  aiActions: { pendingCount: number; oldestAgeLabel: string };
  interventions: { openCount: number; oldestAgeLabel: string };
  disconnects: { totalCount: number; primaryClusterLabel: string };
  mergeQueue: { openCount: number; oldestAgeLabel: string };
  migration: { unresolvedCount: number; oldestAgeLabel: string };
  audit: { changeCount24h: number; lastActorLabel: string };
  procore: { conflictCount: number; healthLabel: string };
}

function formatAgeLabel(value: string | number | null | undefined) {
  const minutes = Number(value ?? 0);
  if (!Number.isFinite(minutes) || minutes <= 0) return "0m";
  if (minutes >= 1440) return `${Math.round(minutes / 1440)}d`;
  if (minutes >= 60) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes)}m`;
}

async function readAiActionSummary(tenantDb: TenantDb, activeOfficeId: string) {
  const result = await tenantDb.execute(sql`
    select
      count(*)::int as pending_count,
      coalesce(max(extract(epoch from now() - created_at) / 60), 0)::int as oldest_minutes
    from job_queue
    where office_id = ${activeOfficeId}
      and status = 'pending'
      and job_type like 'ai_%'
  `);
  const row = (result as any).rows?.[0] ?? {};
  return {
    pendingCount: Number(row.pending_count ?? 0),
    oldestAgeLabel: formatAgeLabel(row.oldest_minutes),
  };
}

async function readInterventionSummary(tenantDb: TenantDb, activeOfficeId: string) {
  const result = await tenantDb.execute(sql`
    select
      count(*)::int as open_count,
      coalesce(max(extract(epoch from now() - first_detected_at) / 60), 0)::int as oldest_minutes
    from ai_disconnect_cases
    where office_id = ${activeOfficeId}
      and status = 'open'
  `);
  const row = (result as any).rows?.[0] ?? {};
  return {
    openCount: Number(row.open_count ?? 0),
    oldestAgeLabel: formatAgeLabel(row.oldest_minutes),
  };
}

async function readDisconnectSummary(tenantDb: TenantDb, activeOfficeId: string) {
  const result = await tenantDb.execute(sql`
    select
      count(*)::int as total_count,
      coalesce((
        select cluster_key
        from ai_disconnect_cases
        where office_id = ${activeOfficeId}
          and status = 'open'
          and cluster_key is not null
        group by cluster_key
        order by count(*) desc, cluster_key asc
        limit 1
      ), 'No active cluster') as primary_cluster_label
    from ai_disconnect_cases
    where office_id = ${activeOfficeId}
      and status = 'open'
  `);
  const row = (result as any).rows?.[0] ?? {};
  return {
    totalCount: Number(row.total_count ?? 0),
    primaryClusterLabel: String(row.primary_cluster_label ?? "No active cluster"),
  };
}

async function readMergeQueueSummary(tenantDb: TenantDb, _activeOfficeId: string) {
  const result = await tenantDb.execute(sql`
    select
      count(*)::int as open_count,
      coalesce(max(extract(epoch from now() - created_at) / 60), 0)::int as oldest_minutes
    from duplicate_queue
    where status = 'pending'
  `);
  const row = (result as any).rows?.[0] ?? {};
  return {
    openCount: Number(row.open_count ?? 0),
    oldestAgeLabel: formatAgeLabel(row.oldest_minutes),
  };
}

async function readMigrationSummary(_tenantDb: TenantDb, _activeOfficeId: string) {
  const summary = await getMigrationSummary();
  const unresolvedCount =
    (summary.deals?.needs_review ?? 0) +
    (summary.contacts?.needs_review ?? 0) +
    (summary.activities?.needs_review ?? 0) +
    (summary.companies?.needs_review ?? 0) +
    (summary.properties?.needs_review ?? 0) +
    (summary.leads?.needs_review ?? 0);
  const latestRunAt = summary.recentRuns[0]?.startedAt ?? null;

  return {
    unresolvedCount,
    oldestAgeLabel: latestRunAt
      ? formatAgeLabel(Math.round((Date.now() - new Date(latestRunAt).getTime()) / 60000))
      : "No runs",
  };
}

async function readAuditSummary(tenantDb: TenantDb, _activeOfficeId: string) {
  const result = await tenantDb.execute(sql`
    select
      count(*) filter (where al.created_at >= now() - interval '24 hours')::int as change_count_24h,
      coalesce(
        (
          select coalesce(u.display_name, al_latest.changed_by::text)
          from audit_log al_latest
          left join public.users u on u.id = al_latest.changed_by
          order by al_latest.created_at desc
          limit 1
        ),
        'No recent changes'
      ) as last_actor_label
    from audit_log al
  `);
  const row = (result as any).rows?.[0] ?? {};
  return {
    changeCount24h: Number(row.change_count_24h ?? 0),
    lastActorLabel: String(row.last_actor_label ?? "No recent changes"),
  };
}

async function readProcoreSummary(tenantDb: TenantDb, activeOfficeId: string) {
  const result = await tenantDb.execute(sql`
    select
      count(*) filter (where sync_status = 'conflict')::int as conflict_count
    from procore_sync_state
    where office_id = ${activeOfficeId}
  `);
  const row = (result as any).rows?.[0] ?? {};
  const conflictCount = Number(row.conflict_count ?? 0);
  return {
    conflictCount,
    healthLabel: conflictCount > 0 ? "Needs review" : "Healthy",
  };
}

export async function getAdminDashboardSummary(
  tenantDb: TenantDb,
  activeOfficeId: string
): Promise<AdminDashboardSummary> {
  const [aiActions, interventions, disconnects, mergeQueue, migration, audit, procore] = await runSequential([
    () => readAiActionSummary(tenantDb, activeOfficeId),
    () => readInterventionSummary(tenantDb, activeOfficeId),
    () => readDisconnectSummary(tenantDb, activeOfficeId),
    () => readMergeQueueSummary(tenantDb, activeOfficeId),
    () => readMigrationSummary(tenantDb, activeOfficeId),
    () => readAuditSummary(tenantDb, activeOfficeId),
    () => readProcoreSummary(tenantDb, activeOfficeId),
  ]);

  return {
    aiActions,
    interventions,
    disconnects,
    mergeQueue,
    migration,
    audit,
    procore,
  };
}
