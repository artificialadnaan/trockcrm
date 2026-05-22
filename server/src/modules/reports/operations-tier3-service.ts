import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { buildOfficeMatcher } from "./office-filter.js";
import {
  aliasedActiveDealCountFilterSql,
  aliasedDealBestEstimateWithForecastSql,
  aliasedEffectiveDealValueSql,
} from "../shared/deal-value-sql.js";

type TenantDb = NodePgDatabase<typeof schema>;
type ExecuteRows<T> = { rows: T[] } | T[];

const CACHE_TTL_MS = 5 * 60 * 1000;
const STUCK_DAYS_THRESHOLD = 30;
const READINESS_STUCK_DAYS_THRESHOLD = 7;

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

const reportCache = new Map<string, CacheEntry<unknown>>();

export interface OperationsReportFilters {
  dateFrom: string;
  dateTo: string;
  office?: string;
  ownerIds: string[];
  ownerNames: string[];
  cacheScope: string;
}

export interface WorkflowBottleneckStage {
  stageName: string;
  openDealCount: number;
  avgDaysInStage: number;
  medianDaysInStage: number;
  maxDaysInStage: number;
  stuckDealCount: number;
}

export interface WorkflowBottleneckDeal {
  dealId: string;
  dealName: string;
  ownerName: string;
  stageName: string;
  daysInStage: number;
  daysSinceLastActivity: number | null;
  value: number;
  projectNumber: string | null;
}

export interface WorkflowBottlenecksReport {
  generatedAt: string;
  filters: OperationsReportFilters;
  kpis: {
    totalStuckDeals: number;
    avgDealAge: number;
    longestStuckDealAge: number;
    stagesWithFivePlusStuckDeals: number;
  };
  stageAging: WorkflowBottleneckStage[];
  topStuckDeals: WorkflowBottleneckDeal[];
  handoffBlockages: WorkflowBottleneckDeal[];
}

export interface ProjectReadinessMissingDeal {
  dealId: string;
  dealName: string;
  ownerName: string;
  stageName: string;
  daysInStage: number;
  missingItems: string[];
  projectNumber: string | null;
}

export interface ProjectReadinessReport {
  generatedAt: string;
  filters: OperationsReportFilters;
  assumption: string;
  kpis: {
    dealsInScoping: number;
    dealsInEstimating: number;
    dealsContractReady: number;
    dealsKickoffReady: number;
  };
  checklistBreakdown: Array<{
    stageGroup: "Scoping" | "Estimating" | "Contract" | "Kickoff";
    completeCount: number;
    incompleteCount: number;
    signals: string[];
  }>;
  missingReadiness: ProjectReadinessMissingDeal[];
  ownerSummary: Array<{
    ownerName: string;
    scopingIncomplete: number;
    estimatingIncomplete: number;
    kickoffIncomplete: number;
  }>;
}

export interface PortfolioLoadReport {
  generatedAt: string;
  filters: OperationsReportFilters;
  kpis: {
    activeCompanies: number;
    activeProperties: number;
    totalActiveValue: number;
    avgDealValuePerCompany: number;
  };
  companyBreakdown: Array<{
    companyId: string | null;
    companyName: string;
    activeDealCount: number;
    totalOpenValue: number;
    topProperty: string;
    owners: string[];
    avgDealAge: number;
  }>;
  propertyBreakdown: Array<{
    propertyId: string | null;
    propertyName: string;
    companyName: string;
    activeDealCount: number;
    totalValue: number;
    mostRecentActivity: string | null;
    ownerName: string;
  }>;
  concentrationRisk: Array<{
    companyName: string;
    totalOpenValue: number;
    percentOfOpenPipeline: number;
  }>;
  geographicSpread: {
    byOffice: Array<{ office: string; dealCount: number; totalValue: number }>;
    byRegion: Array<{ region: string; dealCount: number; totalValue: number }>;
  };
}

interface StageAgingSqlRow extends Record<string, unknown> {
  stage_name: string | null;
  open_deal_count: number | string | null;
  avg_days_in_stage: number | string | null;
  median_days_in_stage: number | string | null;
  max_days_in_stage: number | string | null;
  stuck_deal_count: number | string | null;
}

interface WorkflowDealSqlRow extends Record<string, unknown> {
  deal_id: string;
  deal_name: string;
  owner_name: string | null;
  stage_name: string | null;
  stage_slug: string | null;
  days_in_stage: number | string | null;
  days_since_last_activity: number | string | null;
  value: number | string | null;
  project_number: string | null;
}

interface ReadinessSqlRow extends WorkflowDealSqlRow {
  proposal_status: string | null;
  proposal_sent_at: string | Date | null;
  proposal_accepted_at: string | Date | null;
  contract_signed_date: string | null;
  contract_signed_at: string | Date | null;
  bid_board_assigned_pm: string | null;
  next_milestone_at: string | Date | null;
  scoping_status: string | null;
  completion_state: Record<string, unknown> | null;
  readiness_errors: Record<string, unknown> | null;
}

interface PortfolioDealSqlRow extends Record<string, unknown> {
  deal_id: string;
  company_id: string | null;
  company_name: string | null;
  property_id: string | null;
  property_name: string | null;
  owner_name: string | null;
  office_code: string | null;
  city: string | null;
  state: string | null;
  region: string | null;
  value: number | string | null;
  days_in_stage: number | string | null;
  last_activity_at: string | Date | null;
}

function rowsFromExecute<T>(result: ExecuteRows<T>): T[] {
  return Array.isArray(result) ? result : result.rows;
}

function numberFrom(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumberFrom(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function todayInput() {
  return new Date().toISOString().slice(0, 10);
}

function ninetyDaysAgoInput() {
  const date = new Date();
  date.setDate(date.getDate() - 90);
  return date.toISOString().slice(0, 10);
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeOperationsReportFilters(
  input: {
    dateFrom?: string;
    dateTo?: string;
    office?: string;
    ownerIds?: string[] | string;
    ownerNames?: string[] | string;
    cacheScope?: string;
  } = {}
): OperationsReportFilters {
  const ownerIds = Array.isArray(input.ownerIds)
    ? input.ownerIds
    : typeof input.ownerIds === "string"
      ? input.ownerIds.split(",")
      : [];
  const ownerNames = Array.isArray(input.ownerNames)
    ? input.ownerNames
    : typeof input.ownerNames === "string"
      ? input.ownerNames.split(",")
      : [];

  return {
    dateFrom: cleanString(input.dateFrom) ?? ninetyDaysAgoInput(),
    dateTo: cleanString(input.dateTo) ?? todayInput(),
    office: cleanString(input.office),
    ownerIds: ownerIds.map((ownerId) => ownerId.trim()).filter(Boolean),
    ownerNames: ownerNames.map((ownerName) => ownerName.trim()).filter(Boolean),
    cacheScope: cleanString(input.cacheScope) ?? "default",
  };
}

export function clearOperationsReportsCache() {
  reportCache.clear();
}

function withCache<T extends { filters: OperationsReportFilters }>(
  reportName: string,
  filters: OperationsReportFilters,
  loader: () => Promise<T>,
) {
  // Active-work reports intentionally ignore date filters in SQL (see
  // baseOpenDealWhere). Stripping dateFrom/dateTo from the cache key prevents
  // identical queries from re-running just because the URL date range moved.
  const { dateFrom: _from, dateTo: _to, ...cacheableFilters } = filters;
  const cacheKey = JSON.stringify({ reportName, filters: cacheableFilters });
  const cached = reportCache.get(cacheKey) as CacheEntry<T> | undefined;
  if (cached && cached.expiresAt > Date.now()) {
    // The cached payload may have been built for a different requested date
    // range. Overlay the current request's filters so the response metadata
    // (and any downstream consumers that read filters.dateFrom/dateTo) match
    // what the caller asked for.
    return Promise.resolve({ ...cached.value, filters });
  }

  return loader().then((value) => {
    reportCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, value });
    return value;
  });
}

function ownerFilter(filters: OperationsReportFilters) {
  if (!filters.ownerIds.length && !filters.ownerNames.length) return sql`TRUE`;
  const clauses = [];
  if (filters.ownerIds.length) {
    clauses.push(sql`d.assigned_rep_id::text IN (${sql.join(filters.ownerIds.map((id) => sql`${id}`), sql`, `)})`);
  }
  if (filters.ownerNames.length) {
    clauses.push(sql`u.display_name IN (${sql.join(filters.ownerNames.map((name) => sql`${name}`), sql`, `)})`);
  }
  return sql`(${sql.join(clauses, sql` OR `)})`;
}

function officeFilter(filters: OperationsReportFilters) {
  return buildOfficeMatcher(filters.office, {
    officeId: sql`office_scope.id`,
    officeSlug: sql`office_scope.slug`,
    officeName: sql`office_scope.name`,
    dealOfficeCode: sql`d.office_code`,
  }) ?? sql`TRUE`;
}

function baseOpenDealWhere(filters: OperationsReportFilters) {
  // These Operations reports answer "what is currently active?" Current active
  // work must not be bounded by the selected date range, or old-but-still-stuck
  // deals disappear from bottleneck/readiness/load views. Date filters should
  // only be applied by future time-bounded analyses against event timestamps
  // such as stage_entered_at or deal_stage_history.changed_at.
  return sql`
    d.is_active = TRUE
    AND psc.is_terminal = FALSE
    AND ${officeFilter(filters)}
    AND ${ownerFilter(filters)}
  `;
}

function activeDealJoins() {
  return sql`
    JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
    LEFT JOIN public.users u ON u.id = d.assigned_rep_id
    LEFT JOIN public.offices office_scope
      ON LOWER(office_scope.slug) = LOWER(COALESCE(d.office_code, ''))
      OR LOWER(office_scope.name) = LOWER(COALESCE(d.office_code, ''))
      OR office_scope.id::text = d.office_code
  `;
}

function mapWorkflowDeal(row: WorkflowDealSqlRow): WorkflowBottleneckDeal {
  return {
    dealId: row.deal_id,
    dealName: row.deal_name,
    ownerName: row.owner_name ?? "Unassigned",
    stageName: row.stage_name ?? "Unknown Stage",
    daysInStage: Math.round(numberFrom(row.days_in_stage)),
    daysSinceLastActivity: nullableNumberFrom(row.days_since_last_activity),
    value: numberFrom(row.value),
    projectNumber: row.project_number,
  };
}

export async function getWorkflowBottlenecksReport(
  tenantDb: TenantDb,
  input: Partial<OperationsReportFilters> = {}
): Promise<WorkflowBottlenecksReport> {
  const filters = normalizeOperationsReportFilters(input);

  return withCache("workflow-bottlenecks", filters, async () => {
    const stageRows = rowsFromExecute<StageAgingSqlRow>(await tenantDb.execute(sql`
      SELECT
        psc.name AS stage_name,
        COUNT(*)::int AS open_deal_count,
        ROUND(AVG(EXTRACT(day FROM NOW() - d.stage_entered_at))::numeric, 1) AS avg_days_in_stage,
        ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(day FROM NOW() - d.stage_entered_at))::numeric, 1) AS median_days_in_stage,
        MAX(EXTRACT(day FROM NOW() - d.stage_entered_at))::int AS max_days_in_stage,
        COUNT(*) FILTER (WHERE d.stage_entered_at <= NOW() - INTERVAL '30 days')::int AS stuck_deal_count
      FROM deals d
      ${activeDealJoins()}
      WHERE ${baseOpenDealWhere(filters)}
        AND ${aliasedActiveDealCountFilterSql("d")}
      GROUP BY psc.id, psc.name, psc.display_order
      ORDER BY avg_days_in_stage DESC, psc.display_order ASC
    `));

    const stuckRows = rowsFromExecute<WorkflowDealSqlRow>(await tenantDb.execute(sql`
      SELECT
        d.id::text AS deal_id,
        d.name AS deal_name,
        COALESCE(u.display_name, 'Unassigned') AS owner_name,
        psc.name AS stage_name,
        psc.slug AS stage_slug,
        EXTRACT(day FROM NOW() - d.stage_entered_at)::int AS days_in_stage,
        CASE WHEN d.last_activity_at IS NULL THEN NULL ELSE EXTRACT(day FROM NOW() - d.last_activity_at)::int END AS days_since_last_activity,
        ${aliasedEffectiveDealValueSql("d", aliasedDealBestEstimateWithForecastSql("d"))} AS value,
        d.project_number
      FROM deals d
      ${activeDealJoins()}
      WHERE ${baseOpenDealWhere(filters)}
        AND ${aliasedActiveDealCountFilterSql("d")}
        AND d.stage_entered_at <= NOW() - INTERVAL '30 days'
      ORDER BY days_in_stage DESC, value DESC
      LIMIT 15
    `));

    const handoffRows = rowsFromExecute<WorkflowDealSqlRow>(await tenantDb.execute(sql`
      SELECT
        d.id::text AS deal_id,
        d.name AS deal_name,
        COALESCE(u.display_name, 'Unassigned') AS owner_name,
        psc.name AS stage_name,
        psc.slug AS stage_slug,
        EXTRACT(day FROM NOW() - d.stage_entered_at)::int AS days_in_stage,
        CASE WHEN d.last_activity_at IS NULL THEN NULL ELSE EXTRACT(day FROM NOW() - d.last_activity_at)::int END AS days_since_last_activity,
        ${aliasedEffectiveDealValueSql("d", aliasedDealBestEstimateWithForecastSql("d"))} AS value,
        d.project_number
      FROM deals d
      ${activeDealJoins()}
      WHERE ${baseOpenDealWhere(filters)}
        AND ${aliasedActiveDealCountFilterSql("d")}
        AND d.stage_entered_at <= NOW() - INTERVAL '15 days'
        AND (
          psc.slug ILIKE '%scoping%'
          OR psc.slug ILIKE '%estimating%'
          OR psc.slug ILIKE '%estimate%'
          OR psc.name ILIKE '%Scoping%'
          OR psc.name ILIKE '%Estimating%'
          OR psc.name ILIKE '%Estimate%'
          OR psc.name ILIKE '%Contract%'
        )
      ORDER BY days_in_stage DESC, value DESC
      LIMIT 15
    `));

    const stageAging = stageRows.map((row) => ({
      stageName: row.stage_name ?? "Unknown Stage",
      openDealCount: numberFrom(row.open_deal_count),
      avgDaysInStage: numberFrom(row.avg_days_in_stage),
      medianDaysInStage: numberFrom(row.median_days_in_stage),
      maxDaysInStage: numberFrom(row.max_days_in_stage),
      stuckDealCount: numberFrom(row.stuck_deal_count),
    }));
    const totalDeals = stageAging.reduce((sum, stage) => sum + stage.openDealCount, 0);
    const weightedAge = stageAging.reduce((sum, stage) => sum + stage.avgDaysInStage * stage.openDealCount, 0);

    return {
      generatedAt: new Date().toISOString(),
      filters,
      kpis: {
        totalStuckDeals: stageAging.reduce((sum, stage) => sum + stage.stuckDealCount, 0),
        avgDealAge: totalDeals > 0 ? Math.round((weightedAge / totalDeals) * 10) / 10 : 0,
        longestStuckDealAge: Math.max(0, ...stuckRows.map((row) => numberFrom(row.days_in_stage))),
        stagesWithFivePlusStuckDeals: stageAging.filter((stage) => stage.stuckDealCount >= 5).length,
      },
      stageAging,
      topStuckDeals: stuckRows.map(mapWorkflowDeal),
      handoffBlockages: handoffRows.map(mapWorkflowDeal),
    };
  });
}

function isCompleteEntry(value: unknown) {
  return Boolean(value && typeof value === "object" && "isComplete" in value && (value as { isComplete?: unknown }).isComplete === true);
}

function startCase(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function missingScopingItems(row: ReadinessSqlRow): string[] {
  const completionState = row.completion_state ?? {};
  const entries = Object.entries(completionState);
  if (!row.scoping_status && entries.length === 0) return ["Scoping intake not started"];

  const missing = entries
    .filter(([, value]) => !isCompleteEntry(value))
    .flatMap(([section, value]) => {
      const entry = value as { missingFields?: unknown; missingAttachments?: unknown };
      const fields = Array.isArray(entry.missingFields) ? entry.missingFields.map(String) : [];
      const attachments = Array.isArray(entry.missingAttachments) ? entry.missingAttachments.map(String) : [];
      if (!fields.length && !attachments.length) return [startCase(section)];
      return [...fields, ...attachments].map((item) => `${startCase(section)}: ${startCase(item)}`);
    });

  return missing.length ? missing : row.scoping_status === "ready" || row.scoping_status === "activated" ? [] : ["Scoping intake not ready"];
}

function classifyReadinessStage(row: ReadinessSqlRow): "Scoping" | "Estimating" | "Contract" | "Kickoff" {
  const haystack = `${row.stage_name ?? ""} ${row.stage_slug ?? ""}`.toLowerCase();
  // Stage identity is the source of truth. Proposal status is only a fallback
  // for ambiguous legacy rows because default statuses like "not_started" exist
  // on many non-estimating deals.
  if (haystack.includes("scop")) return "Scoping";
  if (haystack.includes("contract")) return "Contract";
  if (haystack.includes("kickoff") || haystack.includes("production") || haystack.includes("handoff")) return "Kickoff";
  if (haystack.includes("estimate") || haystack.includes("estimating")) return "Estimating";

  const proposalStatus = row.proposal_status ?? "not_started";
  if (proposalStatus === "accepted" || proposalStatus === "signed") return "Contract";
  if (["drafting", "sent", "under_review", "revision_requested", "rejected"].includes(proposalStatus)) return "Estimating";
  return "Kickoff";
}

function missingReadinessItems(row: ReadinessSqlRow) {
  const stageGroup = classifyReadinessStage(row);
  const missing = new Set<string>();
  const daysInStage = numberFrom(row.days_in_stage);

  if (stageGroup === "Scoping") {
    for (const item of missingScopingItems(row)) missing.add(item);
  }

  if (stageGroup === "Estimating") {
    const status = row.proposal_status ?? "not_started";
    if (!["sent", "under_review", "accepted", "signed"].includes(status) && !row.proposal_sent_at) {
      missing.add("Estimate sent");
    }
    if (daysInStage > READINESS_STUCK_DAYS_THRESHOLD && !["accepted", "signed"].includes(status)) {
      missing.add("Estimate/proposal decision");
    }
  }

  if (stageGroup === "Contract") {
    if (!row.contract_signed_at && !row.contract_signed_date) missing.add("Signed contract");
  }

  if (stageGroup === "Kickoff") {
    if (!row.bid_board_assigned_pm) missing.add("Project manager assigned");
    if (!row.next_milestone_at) missing.add("Kickoff/start milestone");
    if (daysInStage > READINESS_STUCK_DAYS_THRESHOLD && !row.bid_board_assigned_pm) {
      missing.add("Kickoff readiness proxy: over 7 days without PM assignment");
    }
  }

  return { stageGroup, missing: [...missing] };
}

export async function getProjectReadinessReport(
  tenantDb: TenantDb,
  input: Partial<OperationsReportFilters> = {}
): Promise<ProjectReadinessReport> {
  const filters = normalizeOperationsReportFilters(input);

  return withCache("project-readiness", filters, async () => {
    const rows = rowsFromExecute<ReadinessSqlRow>(await tenantDb.execute(sql`
      SELECT
        d.id::text AS deal_id,
        d.name AS deal_name,
        COALESCE(u.display_name, 'Unassigned') AS owner_name,
        psc.name AS stage_name,
        psc.slug AS stage_slug,
        EXTRACT(day FROM NOW() - d.stage_entered_at)::int AS days_in_stage,
        CASE WHEN d.last_activity_at IS NULL THEN NULL ELSE EXTRACT(day FROM NOW() - d.last_activity_at)::int END AS days_since_last_activity,
        ${aliasedEffectiveDealValueSql("d", aliasedDealBestEstimateWithForecastSql("d"))} AS value,
        d.project_number,
        d.proposal_status,
        d.proposal_sent_at,
        d.proposal_accepted_at,
        d.contract_signed_date,
        d.contract_signed_at,
        d.bid_board_assigned_pm,
        d.next_milestone_at,
        dsi.status AS scoping_status,
        dsi.completion_state,
        dsi.readiness_errors
      FROM deals d
      ${activeDealJoins()}
      LEFT JOIN deal_scoping_intake dsi ON dsi.deal_id = d.id
      WHERE ${baseOpenDealWhere(filters)}
      ORDER BY psc.display_order ASC, days_in_stage DESC
    `));

    const missingReadiness: ProjectReadinessMissingDeal[] = [];
    const ownerSummary = new Map<string, { ownerName: string; scopingIncomplete: number; estimatingIncomplete: number; kickoffIncomplete: number }>();
    const breakdown = new Map<ProjectReadinessReport["checklistBreakdown"][number]["stageGroup"], { completeCount: number; incompleteCount: number; signals: Set<string> }>();
    const kpis = {
      dealsInScoping: 0,
      dealsInEstimating: 0,
      dealsContractReady: 0,
      dealsKickoffReady: 0,
    };

    for (const stageGroup of ["Scoping", "Estimating", "Contract", "Kickoff"] as const) {
      breakdown.set(stageGroup, { completeCount: 0, incompleteCount: 0, signals: new Set<string>() });
    }

    for (const row of rows) {
      const { stageGroup, missing } = missingReadinessItems(row);
      const bucket = breakdown.get(stageGroup)!;

      if (stageGroup === "Scoping") kpis.dealsInScoping += 1;
      if (stageGroup === "Estimating") kpis.dealsInEstimating += 1;
      if (row.proposal_status === "accepted" || row.proposal_status === "signed") kpis.dealsContractReady += 1;
      if (row.contract_signed_at || row.contract_signed_date) kpis.dealsKickoffReady += 1;

      if (missing.length) {
        bucket.incompleteCount += 1;
        for (const item of missing) bucket.signals.add(item);
        missingReadiness.push({
          dealId: row.deal_id,
          dealName: row.deal_name,
          ownerName: row.owner_name ?? "Unassigned",
          stageName: row.stage_name ?? "Unknown Stage",
          daysInStage: numberFrom(row.days_in_stage),
          missingItems: missing,
          projectNumber: row.project_number,
        });

        const owner = ownerSummary.get(row.owner_name ?? "Unassigned") ?? {
          ownerName: row.owner_name ?? "Unassigned",
          scopingIncomplete: 0,
          estimatingIncomplete: 0,
          kickoffIncomplete: 0,
        };
        if (stageGroup === "Scoping") owner.scopingIncomplete += 1;
        if (stageGroup === "Estimating" || stageGroup === "Contract") owner.estimatingIncomplete += 1;
        if (stageGroup === "Kickoff") owner.kickoffIncomplete += 1;
        ownerSummary.set(owner.ownerName, owner);
      } else {
        bucket.completeCount += 1;
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      filters,
      assumption: "Kickoff readiness is a v1 proxy because a dedicated kickoff checklist table was not present in the inspected schema.",
      kpis,
      checklistBreakdown: [...breakdown.entries()].map(([stageGroup, value]) => ({
        stageGroup,
        completeCount: value.completeCount,
        incompleteCount: value.incompleteCount,
        signals: [...value.signals],
      })),
      missingReadiness,
      ownerSummary: [...ownerSummary.values()].sort((a, b) =>
        b.scopingIncomplete + b.estimatingIncomplete + b.kickoffIncomplete -
        (a.scopingIncomplete + a.estimatingIncomplete + a.kickoffIncomplete)
      ),
    };
  });
}

export async function getPortfolioLoadReport(
  tenantDb: TenantDb,
  input: Partial<OperationsReportFilters> = {}
): Promise<PortfolioLoadReport> {
  const filters = normalizeOperationsReportFilters(input);

  return withCache("portfolio-load", filters, async () => {
    const rows = rowsFromExecute<PortfolioDealSqlRow>(await tenantDb.execute(sql`
      SELECT
        d.id::text AS deal_id,
        c.id::text AS company_id,
        COALESCE(c.name, 'Unassigned Company') AS company_name,
        p.id::text AS property_id,
        COALESCE(p.name, d.property_address, 'Unassigned Property') AS property_name,
        COALESCE(u.display_name, 'Unassigned') AS owner_name,
        COALESCE(d.office_code, 'Unassigned Office') AS office_code,
        COALESCE(p.city, c.city, d.property_city) AS city,
        COALESCE(p.state, c.state, d.property_state) AS state,
        COALESCE(c.region, d.region_classification) AS region,
        ${aliasedEffectiveDealValueSql("d", aliasedDealBestEstimateWithForecastSql("d"))} AS value,
        EXTRACT(day FROM NOW() - d.stage_entered_at)::int AS days_in_stage,
        COALESCE(d.last_activity_at, p.last_activity_at, c.last_activity_at, d.updated_at) AS last_activity_at
      FROM deals d
      ${activeDealJoins()}
      LEFT JOIN companies c ON c.id = d.company_id
      LEFT JOIN properties p ON p.id = d.property_id
      WHERE ${baseOpenDealWhere(filters)}
        AND ${aliasedActiveDealCountFilterSql("d")}
      ORDER BY value DESC, d.updated_at DESC
    `));

    const companyMap = new Map<string, {
      companyId: string | null;
      companyName: string;
      dealCount: number;
      totalValue: number;
      totalAge: number;
      owners: Set<string>;
      propertyValues: Map<string, number>;
    }>();
    const propertyMap = new Map<string, {
      propertyId: string | null;
      propertyName: string;
      companyName: string;
      dealCount: number;
      totalValue: number;
      mostRecentActivity: string | null;
      owners: Set<string>;
    }>();
    const byOffice = new Map<string, { office: string; dealCount: number; totalValue: number }>();
    const byRegion = new Map<string, { region: string; dealCount: number; totalValue: number }>();

    for (const row of rows) {
      const companyKey = row.company_id ?? row.company_name ?? "unassigned-company";
      const propertyKey = row.property_id ?? `${companyKey}:${row.property_name ?? "unassigned-property"}`;
      const value = numberFrom(row.value);
      const ownerName = row.owner_name ?? "Unassigned";
      const company = companyMap.get(companyKey) ?? {
        companyId: row.company_id,
        companyName: row.company_name ?? "Unassigned Company",
        dealCount: 0,
        totalValue: 0,
        totalAge: 0,
        owners: new Set<string>(),
        propertyValues: new Map<string, number>(),
      };
      company.dealCount += 1;
      company.totalValue += value;
      company.totalAge += numberFrom(row.days_in_stage);
      company.owners.add(ownerName);
      company.propertyValues.set(row.property_name ?? "Unassigned Property", (company.propertyValues.get(row.property_name ?? "Unassigned Property") ?? 0) + value);
      companyMap.set(companyKey, company);

      const property = propertyMap.get(propertyKey) ?? {
        propertyId: row.property_id,
        propertyName: row.property_name ?? "Unassigned Property",
        companyName: row.company_name ?? "Unassigned Company",
        dealCount: 0,
        totalValue: 0,
        mostRecentActivity: null,
        owners: new Set<string>(),
      };
      property.dealCount += 1;
      property.totalValue += value;
      property.owners.add(ownerName);
      const activity = row.last_activity_at ? new Date(row.last_activity_at).toISOString() : null;
      if (activity && (!property.mostRecentActivity || activity > property.mostRecentActivity)) {
        property.mostRecentActivity = activity;
      }
      propertyMap.set(propertyKey, property);

      const officeName = row.office_code ?? "Unassigned Office";
      const office = byOffice.get(officeName) ?? { office: startCase(officeName), dealCount: 0, totalValue: 0 };
      office.dealCount += 1;
      office.totalValue += value;
      byOffice.set(officeName, office);

      const regionName = row.region || [row.city, row.state].filter(Boolean).join(", ") || "Unassigned Region";
      const region = byRegion.get(regionName) ?? { region: regionName, dealCount: 0, totalValue: 0 };
      region.dealCount += 1;
      region.totalValue += value;
      byRegion.set(regionName, region);
    }

    const totalActiveValue = rows.reduce((sum, row) => sum + numberFrom(row.value), 0);
    const companyBreakdown = [...companyMap.values()]
      .map((company) => {
        const topProperty = [...company.propertyValues.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Unassigned Property";
        return {
          companyId: company.companyId,
          companyName: company.companyName,
          activeDealCount: company.dealCount,
          totalOpenValue: company.totalValue,
          topProperty,
          owners: [...company.owners].sort(),
          avgDealAge: company.dealCount ? Math.round((company.totalAge / company.dealCount) * 10) / 10 : 0,
        };
      })
      .sort((a, b) => b.totalOpenValue - a.totalOpenValue);

    return {
      generatedAt: new Date().toISOString(),
      filters,
      kpis: {
        activeCompanies: companyMap.size,
        activeProperties: propertyMap.size,
        totalActiveValue,
        avgDealValuePerCompany: companyMap.size ? totalActiveValue / companyMap.size : 0,
      },
      companyBreakdown,
      propertyBreakdown: [...propertyMap.values()]
        .map((property) => ({
          propertyId: property.propertyId,
          propertyName: property.propertyName,
          companyName: property.companyName,
          activeDealCount: property.dealCount,
          totalValue: property.totalValue,
          mostRecentActivity: property.mostRecentActivity,
          ownerName: [...property.owners].sort().join(", ") || "Unassigned",
        }))
        .sort((a, b) => b.totalValue - a.totalValue),
      concentrationRisk: companyBreakdown.slice(0, 5).map((company) => ({
        companyName: company.companyName,
        totalOpenValue: company.totalOpenValue,
        percentOfOpenPipeline: totalActiveValue ? (company.totalOpenValue / totalActiveValue) * 100 : 0,
      })),
      geographicSpread: {
        byOffice: [...byOffice.values()].sort((a, b) => b.totalValue - a.totalValue),
        byRegion: [...byRegion.values()].sort((a, b) => b.totalValue - a.totalValue),
      },
    };
  });
}
