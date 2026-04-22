import { eq, and, sql, gte, lte, inArray, isNull, not, asc, desc } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  companies,
  dealScopingIntake,
  deals,
  dealStageHistory,
  activities,
  contacts,
  contactDealAssociations,
  tasks,
  pipelineStageConfig,
  users,
  lostDealReasons,
  projectTypeConfig,
} from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import type { DealScopingIntakeStatus, WorkflowRoute } from "@trock-crm/shared/types";
import { db } from "../../db.js";

type TenantDb = NodePgDatabase<typeof schema>;

/** Default to Jan 1 of current year through today */
function defaultDateRange(from?: string, to?: string): { from: string; to: string } {
  const year = new Date().getFullYear();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return {
    from: from ?? `${year}-01-01`,
    to: to ?? today,
  };
}

const LEAD_STALE_THRESHOLD_DAYS = 14;

export interface AnalyticsFilterInput {
  from?: string;
  to?: string;
  officeId?: string;
  regionId?: string;
  repId?: string;
  source?: string;
}

export interface NormalizedAnalyticsFilters {
  from: string;
  to: string;
  officeId?: string;
  regionId?: string;
  repId?: string;
  source?: string;
}

function normalizeAnalyticsValue(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function normalizeAnalyticsFilters(
  input: AnalyticsFilterInput = {}
): NormalizedAnalyticsFilters {
  const { from, to } = defaultDateRange(input.from, input.to);
  return {
    from,
    to,
    officeId: normalizeAnalyticsValue(input.officeId),
    regionId: normalizeAnalyticsValue(input.regionId),
    repId: normalizeAnalyticsValue(input.repId),
    source: normalizeAnalyticsValue(input.source),
  };
}

// ---------------------------------------------------------------------------
// Forecast Accuracy / Pipeline Variance
// ---------------------------------------------------------------------------

export interface ForecastVarianceSummary {
  comparableDeals: number;
  avgInitialVariance: number;
  avgQualifiedVariance: number;
  avgEstimatingVariance: number;
  avgCloseDriftDays: number;
}

export interface ForecastVarianceRepRollup {
  repId: string;
  repName: string;
  comparableDeals: number;
  avgInitialVariance: number;
  avgQualifiedVariance: number;
  avgEstimatingVariance: number;
  avgCloseDriftDays: number;
}

export interface ForecastVarianceDealRow {
  dealId: string;
  dealName: string;
  repName: string;
  workflowRoute: WorkflowRoute;
  initialForecast: number;
  qualifiedForecast: number | null;
  estimatingForecast: number | null;
  awardedAmount: number;
  initialVariance: number;
  qualifiedVariance: number | null;
  estimatingVariance: number | null;
  closeDriftDays: number | null;
}

export interface ForecastVarianceOverview {
  summary: ForecastVarianceSummary;
  repRollups: ForecastVarianceRepRollup[];
  deals: ForecastVarianceDealRow[];
}

function buildForecastVarianceFilterSql(filters: NormalizedAnalyticsFilters) {
  const clauses = [
    sql`cw.captured_at >= ${filters.from}::timestamptz`,
    sql`cw.captured_at < (${filters.to}::date + INTERVAL '1 day')::timestamptz`,
  ];

  if (filters.officeId) {
    clauses.push(sql`u.office_id = ${filters.officeId}::uuid`);
  }
  if (filters.regionId) {
    clauses.push(sql`d.region_id = ${filters.regionId}::uuid`);
  }
  if (filters.repId) {
    clauses.push(sql`d.assigned_rep_id = ${filters.repId}::uuid`);
  }
  if (filters.source) {
    clauses.push(sql`d.source = ${filters.source}`);
  }

  return sql.join(clauses, sql` AND `);
}

function mapForecastVarianceSummaryRow(row?: Record<string, any>): ForecastVarianceSummary {
  return {
    comparableDeals: Number(row?.comparable_deals ?? 0),
    avgInitialVariance: Number(row?.avg_initial_variance ?? 0),
    avgQualifiedVariance: Number(row?.avg_qualified_variance ?? 0),
    avgEstimatingVariance: Number(row?.avg_estimating_variance ?? 0),
    avgCloseDriftDays: Number(row?.avg_close_drift_days ?? 0),
  };
}

export async function getForecastVarianceOverview(
  tenantDb: TenantDb,
  input: AnalyticsFilterInput = {}
): Promise<ForecastVarianceOverview> {
  const filters = normalizeAnalyticsFilters(input);
  const whereSql = buildForecastVarianceFilterSql(filters);

  const summaryResult = await tenantDb.execute(sql`
    WITH forecast_base AS (
      SELECT
        d.id AS deal_id,
        d.name AS deal_name,
        cw.workflow_route,
        cw.assigned_rep_id,
        u.display_name AS rep_name,
        cw.awarded_amount,
        cw.captured_at::date AS actual_close_date,
        cw.expected_close_date,
        initial.forecast_amount AS initial_forecast,
        qualified.forecast_amount AS qualified_forecast,
        estimating.forecast_amount AS estimating_forecast,
        cw.captured_at AS closed_won_captured_at
      FROM deals d
      LEFT JOIN deal_scoping_intake dsi ON dsi.deal_id = d.id
      JOIN deal_forecast_milestones cw
        ON cw.deal_id = d.id
       AND cw.milestone_key = 'closed_won'
      JOIN users u ON u.id = cw.assigned_rep_id
      LEFT JOIN deal_forecast_milestones initial
        ON initial.deal_id = d.id
       AND initial.milestone_key = 'initial'
      LEFT JOIN deal_forecast_milestones qualified
        ON qualified.deal_id = d.id
       AND qualified.milestone_key = 'qualified'
      LEFT JOIN deal_forecast_milestones estimating
        ON estimating.deal_id = d.id
       AND estimating.milestone_key = 'estimating'
      WHERE ${whereSql}
    )
    SELECT
      COUNT(*) FILTER (WHERE initial_forecast IS NOT NULL)::int AS comparable_deals,
      COALESCE(AVG(ABS(awarded_amount - initial_forecast)), 0)::numeric AS avg_initial_variance,
      COALESCE(AVG(ABS(awarded_amount - qualified_forecast)) FILTER (WHERE qualified_forecast IS NOT NULL), 0)::numeric AS avg_qualified_variance,
      COALESCE(AVG(ABS(awarded_amount - estimating_forecast)) FILTER (WHERE estimating_forecast IS NOT NULL), 0)::numeric AS avg_estimating_variance,
      COALESCE(AVG(ABS(actual_close_date - expected_close_date)) FILTER (WHERE actual_close_date IS NOT NULL AND expected_close_date IS NOT NULL), 0)::numeric AS avg_close_drift_days
    FROM forecast_base
  `);

  const repRollupsResult = await tenantDb.execute(sql`
    WITH forecast_base AS (
      SELECT
        d.id AS deal_id,
        cw.assigned_rep_id,
        u.display_name AS rep_name,
        cw.awarded_amount,
        cw.captured_at::date AS actual_close_date,
        cw.expected_close_date,
        initial.forecast_amount AS initial_forecast,
        qualified.forecast_amount AS qualified_forecast,
        estimating.forecast_amount AS estimating_forecast
      FROM deals d
      LEFT JOIN deal_scoping_intake dsi ON dsi.deal_id = d.id
      JOIN deal_forecast_milestones cw
        ON cw.deal_id = d.id
       AND cw.milestone_key = 'closed_won'
      JOIN users u ON u.id = cw.assigned_rep_id
      LEFT JOIN deal_forecast_milestones initial
        ON initial.deal_id = d.id
       AND initial.milestone_key = 'initial'
      LEFT JOIN deal_forecast_milestones qualified
        ON qualified.deal_id = d.id
       AND qualified.milestone_key = 'qualified'
      LEFT JOIN deal_forecast_milestones estimating
        ON estimating.deal_id = d.id
       AND estimating.milestone_key = 'estimating'
      WHERE ${whereSql}
    )
    SELECT
      assigned_rep_id AS rep_id,
      rep_name,
      COUNT(*) FILTER (WHERE initial_forecast IS NOT NULL)::int AS comparable_deals,
      COALESCE(AVG(ABS(awarded_amount - initial_forecast)), 0)::numeric AS avg_initial_variance,
      COALESCE(AVG(ABS(awarded_amount - qualified_forecast)) FILTER (WHERE qualified_forecast IS NOT NULL), 0)::numeric AS avg_qualified_variance,
      COALESCE(AVG(ABS(awarded_amount - estimating_forecast)) FILTER (WHERE estimating_forecast IS NOT NULL), 0)::numeric AS avg_estimating_variance,
      COALESCE(AVG(ABS(actual_close_date - expected_close_date)) FILTER (WHERE actual_close_date IS NOT NULL AND expected_close_date IS NOT NULL), 0)::numeric AS avg_close_drift_days
    FROM forecast_base
    GROUP BY assigned_rep_id, rep_name
    ORDER BY comparable_deals DESC, rep_name ASC
  `);

  const dealRowsResult = await tenantDb.execute(sql`
    WITH forecast_base AS (
      SELECT
        d.id AS deal_id,
        d.name AS deal_name,
        cw.workflow_route,
        u.display_name AS rep_name,
        cw.awarded_amount,
        cw.captured_at::date AS actual_close_date,
        cw.expected_close_date,
        initial.forecast_amount AS initial_forecast,
        qualified.forecast_amount AS qualified_forecast,
        estimating.forecast_amount AS estimating_forecast
      FROM deals d
      LEFT JOIN deal_scoping_intake dsi ON dsi.deal_id = d.id
      JOIN deal_forecast_milestones cw
        ON cw.deal_id = d.id
       AND cw.milestone_key = 'closed_won'
      JOIN users u ON u.id = cw.assigned_rep_id
      LEFT JOIN deal_forecast_milestones initial
        ON initial.deal_id = d.id
       AND initial.milestone_key = 'initial'
      LEFT JOIN deal_forecast_milestones qualified
        ON qualified.deal_id = d.id
       AND qualified.milestone_key = 'qualified'
      LEFT JOIN deal_forecast_milestones estimating
        ON estimating.deal_id = d.id
       AND estimating.milestone_key = 'estimating'
      WHERE ${whereSql}
    )
    SELECT
      deal_id,
      deal_name,
      rep_name,
      workflow_route,
      initial_forecast,
      qualified_forecast,
      estimating_forecast,
      awarded_amount,
      ABS(awarded_amount - initial_forecast)::numeric AS initial_variance,
      ABS(awarded_amount - qualified_forecast)::numeric AS qualified_variance,
      ABS(awarded_amount - estimating_forecast)::numeric AS estimating_variance,
      ABS(actual_close_date - expected_close_date)::int AS close_drift_days
    FROM forecast_base
    WHERE initial_forecast IS NOT NULL
    ORDER BY initial_variance DESC NULLS LAST, deal_name ASC
  `);

  const summaryRows = (summaryResult as any).rows ?? summaryResult;
  const repRows = (repRollupsResult as any).rows ?? repRollupsResult;
  const dealRows = (dealRowsResult as any).rows ?? dealRowsResult;

  return {
    summary: mapForecastVarianceSummaryRow(summaryRows[0]),
    repRollups: repRows.map((row: any) => ({
      repId: row.rep_id,
      repName: row.rep_name,
      comparableDeals: Number(row.comparable_deals ?? 0),
      avgInitialVariance: Number(row.avg_initial_variance ?? 0),
      avgQualifiedVariance: Number(row.avg_qualified_variance ?? 0),
      avgEstimatingVariance: Number(row.avg_estimating_variance ?? 0),
      avgCloseDriftDays: Number(row.avg_close_drift_days ?? 0),
    })),
    deals: dealRows.map((row: any) => ({
      dealId: row.deal_id,
      dealName: row.deal_name,
      repName: row.rep_name,
      workflowRoute: row.workflow_route,
      initialForecast: Number(row.initial_forecast ?? 0),
      qualifiedForecast: row.qualified_forecast === null ? null : Number(row.qualified_forecast),
      estimatingForecast: row.estimating_forecast === null ? null : Number(row.estimating_forecast),
      awardedAmount: Number(row.awarded_amount ?? 0),
      initialVariance: Number(row.initial_variance ?? 0),
      qualifiedVariance: row.qualified_variance === null ? null : Number(row.qualified_variance),
      estimatingVariance: row.estimating_variance === null ? null : Number(row.estimating_variance),
      closeDriftDays: row.close_drift_days === null ? null : Number(row.close_drift_days),
    })),
  };
}

// ---------------------------------------------------------------------------
// 1. Pipeline Summary by Stage
// ---------------------------------------------------------------------------

export interface PipelineSummaryRow {
  stageId: string;
  stageName: string;
  stageColor: string | null;
  displayOrder: number;
  isActivePipeline: boolean;
  dealCount: number;
  totalValue: number;
}

/**
 * Pipeline summary grouped by stage.
 * Shows current active pipeline state (not time-bounded by created_at).
 * @param includeDd - if false, excludes stages where is_active_pipeline = false (DD stages)
 * @param repId - if provided, scope to a single rep's deals
 */
export async function getPipelineSummary(
  tenantDb: TenantDb,
  options: { includeDd?: boolean; from?: string; to?: string; repId?: string } = {}
): Promise<PipelineSummaryRow[]> {
  const includeDd = options.includeDd ?? false;

  // Get all non-terminal stages
  const stages = await db
    .select()
    .from(pipelineStageConfig)
    .where(eq(pipelineStageConfig.isTerminal, false))
    .orderBy(asc(pipelineStageConfig.displayOrder));

  const filteredStages = includeDd
    ? stages
    : stages.filter((s) => s.isActivePipeline);

  const stageIds = filteredStages.map((s) => s.id);
  if (stageIds.length === 0) return [];

  // Active pipeline = current state, not time-bounded
  const repFilter = options.repId
    ? sql`AND d.assigned_rep_id = ${options.repId}`
    : sql``;

  // Aggregate deal counts and values per stage
  const result = await tenantDb.execute(sql`
    SELECT
      d.stage_id,
      COUNT(*)::int AS deal_count,
      COALESCE(SUM(
        COALESCE(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0)
      ), 0)::numeric AS total_value
    FROM deals d
    WHERE d.is_active = true
      AND d.stage_id IN (${sql.join(stageIds.map(id => sql`${id}`), sql`, `)})
      ${repFilter}
    GROUP BY d.stage_id
  `);

  const rows = (result as any).rows ?? result;
  const dataMap = new Map<string, { dealCount: number; totalValue: number }>();
  for (const row of rows) {
    dataMap.set(row.stage_id, {
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

// ---------------------------------------------------------------------------
// 2. Weighted Pipeline Forecast
// ---------------------------------------------------------------------------

export interface WeightedForecastRow {
  month: string; // YYYY-MM
  dealCount: number;
  rawValue: number;
  weightedValue: number;
}

/**
 * Weighted pipeline forecast: deal value * win_probability, grouped by expected_close_date month.
 * Only includes active, non-terminal deals with an expected_close_date.
 * @param repId - if provided, scope to a single rep's deals
 */
export async function getWeightedPipelineForecast(
  tenantDb: TenantDb,
  options: { from?: string; to?: string; repId?: string } = {}
): Promise<WeightedForecastRow[]> {
  const { from, to } = defaultDateRange(options.from, options.to);

  const repFilter = options.repId
    ? sql`AND d.assigned_rep_id = ${options.repId}`
    : sql``;

  const result = await tenantDb.execute(sql`
    SELECT
      TO_CHAR(d.expected_close_date, 'YYYY-MM') AS month,
      COUNT(*)::int AS deal_count,
      COALESCE(SUM(
        COALESCE(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0)
      ), 0)::numeric AS raw_value,
      COALESCE(SUM(
        COALESCE(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0)
        * COALESCE(d.win_probability, 50) / 100.0
      ), 0)::numeric AS weighted_value
    FROM deals d
    JOIN pipeline_stage_config psc ON psc.id = d.stage_id
    WHERE d.is_active = true
      AND psc.is_terminal = false
      AND d.expected_close_date IS NOT NULL
      AND d.expected_close_date >= ${from}::date
      AND d.expected_close_date <= ${to}::date
      ${repFilter}
    GROUP BY TO_CHAR(d.expected_close_date, 'YYYY-MM')
    ORDER BY month ASC
  `);

  const rows = (result as any).rows ?? result;
  return rows.map((r: any) => ({
    month: r.month,
    dealCount: Number(r.deal_count ?? 0),
    rawValue: Number(r.raw_value ?? 0),
    weightedValue: Number(r.weighted_value ?? 0),
  }));
}

// ---------------------------------------------------------------------------
// 3. Win/Loss Ratio by Rep
// ---------------------------------------------------------------------------

export interface WinLossRow {
  repId: string;
  repName: string;
  wins: number;
  losses: number;
  winRate: number; // 0-100
  totalValue: number;
}

/**
 * Win/loss ratio per rep. Uses each deal's current stage (deals.stage_id) to
 * determine outcome, avoiding double-counting deals that were reopened and
 * re-closed. Date filter uses actual_close_date / lost_at for accuracy.
 */
export async function getWinLossRatioByRep(
  tenantDb: TenantDb,
  options: { from?: string; to?: string } = {}
): Promise<WinLossRow[]> {
  const { from, to } = defaultDateRange(options.from, options.to);

  const result = await tenantDb.execute(sql`
    SELECT
      d.assigned_rep_id AS rep_id,
      u.display_name AS rep_name,
      COUNT(*) FILTER (WHERE psc.slug = 'closed_won')::int AS wins,
      COUNT(*) FILTER (WHERE psc.slug = 'closed_lost')::int AS losses,
      COALESCE(SUM(
        COALESCE(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0)
      ) FILTER (WHERE psc.slug = 'closed_won'), 0)::numeric AS total_value
    FROM deals d
    JOIN pipeline_stage_config psc ON psc.id = d.stage_id
    JOIN users u ON u.id = d.assigned_rep_id
    WHERE psc.is_terminal = true
      AND COALESCE(d.actual_close_date, d.lost_at, d.updated_at)
          >= ${from}::timestamptz
      AND COALESCE(d.actual_close_date, d.lost_at, d.updated_at)
          <= (${to}::date + INTERVAL '1 day')::timestamptz
    GROUP BY d.assigned_rep_id, u.display_name
    ORDER BY wins DESC
  `);

  const rows = (result as any).rows ?? result;
  return rows.map((r: any) => {
    const wins = Number(r.wins ?? 0);
    const losses = Number(r.losses ?? 0);
    const total = wins + losses;
    return {
      repId: r.rep_id,
      repName: r.rep_name,
      wins,
      losses,
      winRate: total > 0 ? Math.round((wins / total) * 100) : 0,
      totalValue: Number(r.total_value ?? 0),
    };
  });
}

// ---------------------------------------------------------------------------
// 4. Win Rate Trend (monthly)
// ---------------------------------------------------------------------------

export interface WinRateTrendRow {
  month: string; // YYYY-MM
  wins: number;
  losses: number;
  winRate: number;
}

/**
 * Monthly win rate trend across all reps.
 */
export async function getWinRateTrend(
  tenantDb: TenantDb,
  options: { from?: string; to?: string; repId?: string } = {}
): Promise<WinRateTrendRow[]> {
  const { from, to } = defaultDateRange(options.from, options.to);

  const repFilter = options.repId
    ? sql`AND d.assigned_rep_id = ${options.repId}`
    : sql``;

  const result = await tenantDb.execute(sql`
    SELECT
      TO_CHAR(dsh.created_at AT TIME ZONE 'America/Chicago', 'YYYY-MM') AS month,
      COUNT(*) FILTER (WHERE psc.slug = 'closed_won')::int AS wins,
      COUNT(*) FILTER (WHERE psc.slug = 'closed_lost')::int AS losses
    FROM deal_stage_history dsh
    JOIN deals d ON d.id = dsh.deal_id
    JOIN pipeline_stage_config psc ON psc.id = dsh.to_stage_id
    WHERE psc.is_terminal = true
      AND dsh.created_at >= ${from}::timestamptz
      AND dsh.created_at <= (${to}::date + INTERVAL '1 day')::timestamptz
      ${repFilter}
    GROUP BY TO_CHAR(dsh.created_at AT TIME ZONE 'America/Chicago', 'YYYY-MM')
    ORDER BY month ASC
  `);

  const rows = (result as any).rows ?? result;
  return rows.map((r: any) => {
    const wins = Number(r.wins ?? 0);
    const losses = Number(r.losses ?? 0);
    const total = wins + losses;
    return {
      month: r.month,
      wins,
      losses,
      winRate: total > 0 ? Math.round((wins / total) * 100) : 0,
    };
  });
}

// ---------------------------------------------------------------------------
// 5. Activity Summary by Rep
// ---------------------------------------------------------------------------

export interface ActivitySummaryRow {
  repId: string;
  repName: string;
  calls: number;
  emails: number;
  meetings: number;
  notes: number;
  tasksCompleted: number;
  total: number;
}

/**
 * Activity counts by type, grouped by rep.
 */
export async function getActivitySummaryByRep(
  tenantDb: TenantDb,
  options: { from?: string; to?: string } = {}
): Promise<ActivitySummaryRow[]> {
  const { from, to } = defaultDateRange(options.from, options.to);

  const result = await tenantDb.execute(sql`
    SELECT
      a.responsible_user_id AS rep_id,
      u.display_name AS rep_name,
      COUNT(*) FILTER (WHERE a.type = 'call')::int AS calls,
      COUNT(*) FILTER (WHERE a.type = 'email')::int AS emails,
      COUNT(*) FILTER (WHERE a.type = 'meeting')::int AS meetings,
      COUNT(*) FILTER (WHERE a.type = 'note')::int AS notes,
      COUNT(*) FILTER (WHERE a.type = 'task_completed')::int AS tasks_completed,
      COUNT(*)::int AS total
    FROM activities a
    JOIN users u ON u.id = a.responsible_user_id
    WHERE a.occurred_at >= ${from}::timestamptz
      AND a.occurred_at <= (${to}::date + INTERVAL '1 day')::timestamptz
    GROUP BY a.responsible_user_id, u.display_name
    ORDER BY total DESC
  `);

  const rows = (result as any).rows ?? result;
  return rows.map((r: any) => ({
    repId: r.rep_id,
    repName: r.rep_name,
    calls: Number(r.calls ?? 0),
    emails: Number(r.emails ?? 0),
    meetings: Number(r.meetings ?? 0),
    notes: Number(r.notes ?? 0),
    tasksCompleted: Number(r.tasks_completed ?? 0),
    total: Number(r.total ?? 0),
  }));
}

// ---------------------------------------------------------------------------
// 6. Stale Deals Report
// ---------------------------------------------------------------------------

export interface StaleDealRow {
  dealId: string;
  dealNumber: string;
  dealName: string;
  stageId: string;
  stageName: string;
  assignedRepId: string;
  repName: string;
  stageEnteredAt: string;
  daysInStage: number;
  staleThresholdDays: number;
  dealValue: number;
}

/**
 * Deals that have exceeded their stage's stale_threshold_days.
 */
export async function getStaleDeals(
  tenantDb: TenantDb,
  options: { repId?: string } = {}
): Promise<StaleDealRow[]> {
  const repFilter = options.repId
    ? sql`AND d.assigned_rep_id = ${options.repId}`
    : sql``;

  const result = await tenantDb.execute(sql`
    SELECT
      d.id AS deal_id,
      d.deal_number,
      d.name AS deal_name,
      d.stage_id,
      psc.name AS stage_name,
      d.assigned_rep_id,
      u.display_name AS rep_name,
      d.stage_entered_at,
      EXTRACT(DAY FROM NOW() - d.stage_entered_at)::int AS days_in_stage,
      psc.stale_threshold_days,
      COALESCE(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0)::numeric AS deal_value
    FROM deals d
    JOIN pipeline_stage_config psc ON psc.id = d.stage_id
    JOIN users u ON u.id = d.assigned_rep_id
    WHERE d.is_active = true
      AND psc.is_terminal = false
      AND psc.stale_threshold_days IS NOT NULL
      AND EXTRACT(DAY FROM NOW() - d.stage_entered_at) > psc.stale_threshold_days
      ${repFilter}
    ORDER BY days_in_stage DESC
  `);

  const rows = (result as any).rows ?? result;
  return rows.map((r: any) => ({
    dealId: r.deal_id,
    dealNumber: r.deal_number,
    dealName: r.deal_name,
    stageId: r.stage_id,
    stageName: r.stage_name,
    assignedRepId: r.assigned_rep_id,
    repName: r.rep_name,
    stageEnteredAt: r.stage_entered_at,
    daysInStage: Number(r.days_in_stage ?? 0),
    staleThresholdDays: Number(r.stale_threshold_days ?? 0),
    dealValue: Number(r.deal_value ?? 0),
  }));
}

// ---------------------------------------------------------------------------
// 7. Lost Deals by Reason (with competitor breakdown)
// ---------------------------------------------------------------------------

export interface LostDealsByReasonRow {
  reasonId: string | null;
  reasonLabel: string;
  count: number;
  totalValue: number;
  competitors: Array<{ name: string; count: number }>;
}

/**
 * Lost deals grouped by reason, with competitor sub-grouping.
 */
export async function getLostDealsByReason(
  tenantDb: TenantDb,
  options: { from?: string; to?: string } = {}
): Promise<LostDealsByReasonRow[]> {
  const { from, to } = defaultDateRange(options.from, options.to);

  // Get reason-level aggregates
  const reasonResult = await tenantDb.execute(sql`
    SELECT
      d.lost_reason_id AS reason_id,
      COALESCE(ldr.label, 'Unknown') AS reason_label,
      COUNT(*)::int AS count,
      COALESCE(SUM(
        COALESCE(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0)
      ), 0)::numeric AS total_value
    FROM deals d
    LEFT JOIN lost_deal_reasons ldr ON ldr.id = d.lost_reason_id
    JOIN pipeline_stage_config psc ON psc.id = d.stage_id
    WHERE psc.slug = 'closed_lost'
      AND d.lost_at >= ${from}::timestamptz
      AND d.lost_at <= (${to}::date + INTERVAL '1 day')::timestamptz
    GROUP BY d.lost_reason_id, ldr.label
    ORDER BY count DESC
  `);

  // Get competitor breakdown for each reason
  const competitorResult = await tenantDb.execute(sql`
    SELECT
      d.lost_reason_id AS reason_id,
      COALESCE(NULLIF(TRIM(d.lost_competitor), ''), 'Not specified') AS competitor,
      COUNT(*)::int AS count
    FROM deals d
    JOIN pipeline_stage_config psc ON psc.id = d.stage_id
    WHERE psc.slug = 'closed_lost'
      AND d.lost_at >= ${from}::timestamptz
      AND d.lost_at <= (${to}::date + INTERVAL '1 day')::timestamptz
    GROUP BY d.lost_reason_id, competitor
    ORDER BY count DESC
  `);

  const reasonRows = (reasonResult as any).rows ?? reasonResult;
  const compRows = (competitorResult as any).rows ?? competitorResult;

  // Group competitors by reason
  const compByReason = new Map<string | null, Array<{ name: string; count: number }>>();
  for (const cr of compRows) {
    const key = cr.reason_id ?? "__null__";
    const arr = compByReason.get(key) ?? [];
    arr.push({ name: cr.competitor, count: Number(cr.count ?? 0) });
    compByReason.set(key, arr);
  }

  return reasonRows.map((r: any) => ({
    reasonId: r.reason_id,
    reasonLabel: r.reason_label,
    count: Number(r.count ?? 0),
    totalValue: Number(r.total_value ?? 0),
    competitors: compByReason.get(r.reason_id ?? "__null__") ?? [],
  }));
}

// ---------------------------------------------------------------------------
// 8. Revenue by Project Type
// ---------------------------------------------------------------------------

export interface RevenueByProjectTypeRow {
  projectTypeId: string | null;
  projectTypeName: string;
  dealCount: number;
  totalRevenue: number;
}

/**
 * Revenue from closed-won deals grouped by project type.
 */
export async function getRevenueByProjectType(
  tenantDb: TenantDb,
  options: { from?: string; to?: string } = {}
): Promise<RevenueByProjectTypeRow[]> {
  const { from, to } = defaultDateRange(options.from, options.to);

  const result = await tenantDb.execute(sql`
    SELECT
      d.project_type_id,
      COALESCE(ptc.name, 'Unspecified') AS project_type_name,
      COUNT(*)::int AS deal_count,
      COALESCE(SUM(
        COALESCE(d.awarded_amount, d.bid_estimate, 0)
      ), 0)::numeric AS total_revenue
    FROM deals d
    LEFT JOIN project_type_config ptc ON ptc.id = d.project_type_id
    JOIN pipeline_stage_config psc ON psc.id = d.stage_id
    WHERE psc.slug = 'closed_won'
      AND d.actual_close_date >= ${from}::date
      AND d.actual_close_date <= ${to}::date
    GROUP BY d.project_type_id, ptc.name
    ORDER BY total_revenue DESC
  `);

  const rows = (result as any).rows ?? result;
  return rows.map((r: any) => ({
    projectTypeId: r.project_type_id,
    projectTypeName: r.project_type_name,
    dealCount: Number(r.deal_count ?? 0),
    totalRevenue: Number(r.total_revenue ?? 0),
  }));
}

// ---------------------------------------------------------------------------
// 9. Lead Source ROI
// ---------------------------------------------------------------------------

export interface LeadSourceROIRow {
  source: string;
  leadCount: number;
  dealCount: number;
  activeDeals: number;
  wonDeals: number;
  lostDeals: number;
  activePipelineValue: number;
  wonValue: number;
  winRate: number;
}

/**
 * Lead source performance: deals won, pipeline value, and win rate by source.
 */
export async function getLeadSourceROI(
  tenantDb: TenantDb,
  options: AnalyticsFilterInput = {}
): Promise<LeadSourceROIRow[]> {
  const filters = normalizeAnalyticsFilters(options);
  const officeFilter = filters.officeId
    ? sql`AND dsi.office_id = ${filters.officeId}`
    : sql``;
  const regionFilter = filters.regionId
    ? sql`AND d.region_id = ${filters.regionId}`
    : sql``;
  const repFilter = filters.repId
    ? sql`AND d.assigned_rep_id = ${filters.repId}`
    : sql``;
  const sourceFilter = filters.source
    ? sql`AND COALESCE(NULLIF(TRIM(d.source), ''), 'Unknown') = ${filters.source}`
    : sql``;

  const result = await tenantDb.execute(sql`
    SELECT
      COALESCE(NULLIF(TRIM(d.source), ''), 'Unknown') AS source,
      COUNT(DISTINCT dsi.id)::int AS lead_count,
      COUNT(DISTINCT d.id)::int AS deal_count,
      COUNT(DISTINCT d.id) FILTER (WHERE d.is_active = true AND NOT psc.is_terminal)::int AS active_deals,
      COUNT(DISTINCT d.id) FILTER (WHERE psc.slug = 'closed_won')::int AS won_deals,
      COUNT(DISTINCT d.id) FILTER (WHERE psc.slug = 'closed_lost')::int AS lost_deals,
      COALESCE(SUM(
        COALESCE(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0)
      ) FILTER (WHERE d.is_active = true AND NOT psc.is_terminal), 0)::numeric AS active_pipeline_value,
      COALESCE(SUM(
        COALESCE(d.awarded_amount, d.bid_estimate, 0)
      ) FILTER (WHERE psc.slug = 'closed_won'), 0)::numeric AS won_value
    FROM deals d
    LEFT JOIN deal_scoping_intake dsi ON dsi.deal_id = d.id
    JOIN pipeline_stage_config psc ON psc.id = d.stage_id
    WHERE d.created_at >= ${filters.from}::timestamptz
      AND d.created_at <= (${filters.to}::date + INTERVAL '1 day')::timestamptz
      ${officeFilter}
      ${regionFilter}
      ${repFilter}
      ${sourceFilter}
    GROUP BY COALESCE(NULLIF(TRIM(d.source), ''), 'Unknown')
    ORDER BY won_value DESC
  `);

  const rows = (result as any).rows ?? result;
  return rows.map((r: any) => {
    const leadCount = Number(r.lead_count ?? 0);
    const dealCount = Number(r.deal_count ?? r.total_deals ?? 0);
    const won = Number(r.won_deals ?? 0);
    const lost = Number(r.lost_deals ?? 0);
    const closedTotal = won + lost;
    const activePipelineValue = Number(r.active_pipeline_value ?? r.pipeline_value ?? 0);
    return {
      source: r.source,
      leadCount,
      dealCount,
      activeDeals: Number(r.active_deals ?? 0),
      wonDeals: won,
      lostDeals: lost,
      activePipelineValue,
      wonValue: Number(r.won_value ?? 0),
      winRate: closedTotal > 0 ? Math.round((won / closedTotal) * 100) : 0,
    };
  });
}

// ---------------------------------------------------------------------------
// 10. Data Mining
// ---------------------------------------------------------------------------

export interface DataMiningUntouchedContactRow {
  contactId: string;
  contactName: string;
  companyName: string;
  daysSinceTouch: number;
  lastTouchedAt: string | null;
}

export interface DataMiningDormantCompanyRow {
  companyId: string;
  companyName: string;
  daysSinceActivity: number;
  lastActivityAt: string | null;
  activeDealCount: number;
}

export interface DataMiningOverview {
  summary: {
    untouchedContact30Count: number;
    untouchedContact60Count: number;
    untouchedContact90Count: number;
    dormantCompany90Count: number;
  };
  untouchedContacts: DataMiningUntouchedContactRow[];
  dormantCompanies: DataMiningDormantCompanyRow[];
}

export async function getDataMiningOverview(
  tenantDb: TenantDb,
  options: AnalyticsFilterInput = {}
): Promise<DataMiningOverview> {
  const filters = normalizeAnalyticsFilters(options);
  const officeDealContext = sql`
    office_deals AS (
      SELECT DISTINCT
        d.id,
        d.company_id,
        d.region_id,
        d.assigned_rep_id,
        d.is_active,
        psc.is_terminal,
        COALESCE(NULLIF(TRIM(d.source), ''), 'Unknown') AS source
      FROM deals d
      LEFT JOIN deal_scoping_intake dsi ON dsi.deal_id = d.id
      JOIN pipeline_stage_config psc ON psc.id = d.stage_id
      WHERE TRUE
        ${filters.officeId ? sql`AND dsi.office_id = ${filters.officeId}` : sql``}
        ${filters.regionId ? sql`AND d.region_id = ${filters.regionId}` : sql``}
        ${filters.repId ? sql`AND d.assigned_rep_id = ${filters.repId}` : sql``}
        ${filters.source ? sql`AND COALESCE(NULLIF(TRIM(d.source), ''), 'Unknown') = ${filters.source}` : sql``}
    )
  `;
  const officeContactContext = sql`
    office_contact_context AS (
      SELECT DISTINCT
        c.id AS contact_id,
        c.company_id,
        TRIM(CONCAT_WS(' ', c.first_name, c.last_name)) AS contact_name,
        COALESCE(NULLIF(TRIM(c.company_name), ''), COALESCE(comp.name, 'Unassigned')) AS company_name,
        c.created_at
      FROM contacts c
      LEFT JOIN companies comp ON comp.id = c.company_id
      WHERE c.is_active = true
        AND EXISTS (
          SELECT 1
          FROM contact_deal_associations cda
          JOIN office_deals od ON od.id = cda.deal_id
          WHERE cda.contact_id = c.id
        )
    )
  `;
  const officeCompanyContext = sql`
    office_company_context AS (
      SELECT DISTINCT
        c.id AS company_id,
        COALESCE(NULLIF(TRIM(c.name), ''), 'Unassigned') AS company_name,
        c.created_at
      FROM companies c
      WHERE c.is_active = true
        AND EXISTS (
          SELECT 1
          FROM office_deals od
          WHERE od.company_id = c.id
        )
    )
  `;
  const officeContactActivityScope = sql`
    office_contact_activity_scope AS (
      SELECT
        occ.contact_id,
        occ.company_id,
        a.occurred_at
      FROM office_contact_context occ
      JOIN activities a ON a.contact_id = occ.contact_id
    )
  `;
  const officeOfficeActivityScope = sql`
    office_office_activity_scope AS (
      SELECT
        occ.company_id,
        a.occurred_at
      FROM office_company_context occ
      JOIN activities a ON a.company_id = occ.company_id
      ${filters.officeId ? sql`
      JOIN users u ON u.id = a.responsible_user_id
      WHERE u.office_id = ${filters.officeId}
      ` : sql`WHERE 1 = 0`}
      UNION ALL
      SELECT
        od.company_id,
        a.occurred_at
      FROM office_deals od
      JOIN activities a ON a.deal_id = od.id
    )
  `;

  const [untouchedContactSummaryResult, untouchedContactRowsResult, dormantCompanySummaryResult, dormantCompanyRowsResult] = await Promise.all([
    tenantDb.execute(sql`
      WITH
      ${officeDealContext},
      ${officeContactContext},
      ${officeContactActivityScope},
      ${officeOfficeActivityScope},
      contact_activity AS (
        SELECT
          activity.contact_id,
          MAX(activity.occurred_at) AS last_activity_at
        FROM (
          SELECT contact_id, occurred_at
          FROM office_contact_activity_scope
          UNION ALL
          SELECT occ.contact_id, oas.occurred_at
          FROM office_contact_context occ
          JOIN office_office_activity_scope oas ON oas.company_id = occ.company_id
        ) activity
        GROUP BY activity.contact_id
      ),
      ranked_contacts AS (
        SELECT
          occ.contact_id,
          occ.contact_name,
          occ.company_name,
          GREATEST(COALESCE(ca.last_activity_at, occ.created_at), occ.created_at) AS last_touch_at,
          EXTRACT(DAY FROM (${filters.to}::date + INTERVAL '1 day')::timestamptz - GREATEST(COALESCE(ca.last_activity_at, occ.created_at), occ.created_at))::int AS days_since_touch
        FROM office_contact_context occ
        LEFT JOIN contact_activity ca ON ca.contact_id = occ.contact_id
      )
      SELECT
        COUNT(*) FILTER (WHERE days_since_touch >= 30)::int AS untouched_contact_30_count,
        COUNT(*) FILTER (WHERE days_since_touch >= 60)::int AS untouched_contact_60_count,
        COUNT(*) FILTER (WHERE days_since_touch >= 90)::int AS untouched_contact_90_count
      FROM ranked_contacts
    `),
    tenantDb.execute(sql`
      WITH
      ${officeDealContext},
      ${officeContactContext},
      ${officeCompanyContext},
      ${officeContactActivityScope},
      ${officeOfficeActivityScope},
      company_activity AS (
        SELECT
          activity.company_id,
          MAX(activity.occurred_at) AS last_activity_at
        FROM (
          SELECT company_id, occurred_at
          FROM office_office_activity_scope
          UNION ALL
          SELECT occ.company_id, oas.occurred_at
          FROM office_contact_activity_scope oas
          JOIN office_contact_context occ ON occ.contact_id = oas.contact_id
        ) activity
        GROUP BY activity.company_id
      ),
      ranked_companies AS (
        SELECT
          occ.company_id,
          occ.company_name,
          COALESCE(ca.last_activity_at, occ.created_at) AS last_touch_at,
          EXTRACT(DAY FROM (${filters.to}::date + INTERVAL '1 day')::timestamptz - COALESCE(ca.last_activity_at, occ.created_at))::int AS days_since_activity,
          (
            SELECT COUNT(*)::int
            FROM office_deals od
            WHERE od.company_id = occ.company_id
              AND od.is_active = true
              AND od.is_terminal = false
          ) AS active_deal_count
        FROM office_company_context occ
        LEFT JOIN company_activity ca ON ca.company_id = occ.company_id
      )
      SELECT
        COUNT(*) FILTER (WHERE active_deal_count = 0 AND days_since_activity >= 90)::int AS dormant_company_90_count
      FROM ranked_companies
    `),
    tenantDb.execute(sql`
      WITH
      ${officeDealContext},
      ${officeContactContext},
      ${officeContactActivityScope},
      ${officeOfficeActivityScope},
      contact_activity AS (
        SELECT
          activity.contact_id,
          MAX(activity.occurred_at) AS last_activity_at
        FROM (
          SELECT contact_id, occurred_at
          FROM office_contact_activity_scope
          UNION ALL
          SELECT occ.contact_id, oas.occurred_at
          FROM office_contact_context occ
          JOIN office_office_activity_scope oas ON oas.company_id = occ.company_id
        ) activity
        GROUP BY activity.contact_id
      ),
      ranked_contacts AS (
        SELECT
          occ.contact_id,
          occ.contact_name,
          occ.company_name,
          GREATEST(COALESCE(ca.last_activity_at, occ.created_at), occ.created_at) AS last_touch_at,
          EXTRACT(DAY FROM (${filters.to}::date + INTERVAL '1 day')::timestamptz - GREATEST(COALESCE(ca.last_activity_at, occ.created_at), occ.created_at))::int AS days_since_touch
        FROM office_contact_context occ
        LEFT JOIN contact_activity ca ON ca.contact_id = occ.contact_id
      )
      SELECT
        contact_id,
        contact_name,
        company_name,
        last_touch_at,
        days_since_touch
      FROM ranked_contacts
      WHERE days_since_touch >= 30
      ORDER BY days_since_touch DESC, contact_name ASC
      LIMIT 25
    `),
    tenantDb.execute(sql`
      WITH
      ${officeDealContext},
      ${officeContactContext},
      ${officeCompanyContext},
      ${officeContactActivityScope},
      ${officeOfficeActivityScope},
      company_activity AS (
        SELECT
          activity.company_id,
          MAX(activity.occurred_at) AS last_activity_at
        FROM (
          SELECT company_id, occurred_at
          FROM office_office_activity_scope
          UNION ALL
          SELECT occ.company_id, oas.occurred_at
          FROM office_contact_activity_scope oas
          JOIN office_contact_context occ ON occ.contact_id = oas.contact_id
        ) activity
        GROUP BY activity.company_id
      ),
      ranked_companies AS (
        SELECT
          occ.company_id,
          occ.company_name,
          COALESCE(ca.last_activity_at, occ.created_at) AS last_touch_at,
          EXTRACT(DAY FROM (${filters.to}::date + INTERVAL '1 day')::timestamptz - COALESCE(ca.last_activity_at, occ.created_at))::int AS days_since_activity,
          (
            SELECT COUNT(*)::int
            FROM office_deals od
            WHERE od.company_id = occ.company_id
              AND od.is_active = true
              AND od.is_terminal = false
          ) AS active_deal_count
        FROM office_company_context occ
        LEFT JOIN company_activity ca ON ca.company_id = occ.company_id
      )
      SELECT
        company_id,
        company_name,
        last_touch_at,
        days_since_activity,
        active_deal_count
      FROM ranked_companies
      WHERE active_deal_count = 0
        AND days_since_activity >= 90
      ORDER BY days_since_activity DESC, company_name ASC
      LIMIT 25
    `),
  ]);

  const untouchedSummaryRows = (untouchedContactSummaryResult as any).rows ?? untouchedContactSummaryResult;
  const untouchedContactRows = (untouchedContactRowsResult as any).rows ?? untouchedContactRowsResult;
  const dormantSummaryRows = (dormantCompanySummaryResult as any).rows ?? dormantCompanySummaryResult;
  const dormantCompanyRows = (dormantCompanyRowsResult as any).rows ?? dormantCompanyRowsResult;

  const untouchedSummary = untouchedSummaryRows[0] ?? {};
  const dormantSummary = dormantSummaryRows[0] ?? {};

  return {
    summary: {
      untouchedContact30Count: Number(untouchedSummary.untouched_contact_30_count ?? 0),
      untouchedContact60Count: Number(untouchedSummary.untouched_contact_60_count ?? 0),
      untouchedContact90Count: Number(untouchedSummary.untouched_contact_90_count ?? 0),
      dormantCompany90Count: Number(dormantSummary.dormant_company_90_count ?? 0),
    },
    untouchedContacts: untouchedContactRows.map((row: any) => ({
      contactId: row.contact_id,
      contactName: row.contact_name,
      companyName: row.company_name,
      daysSinceTouch: Number(row.days_since_touch ?? 0),
      lastTouchedAt: row.last_touch_at ?? null,
    })),
    dormantCompanies: dormantCompanyRows.map((row: any) => ({
      companyId: row.company_id,
      companyName: row.company_name,
      daysSinceActivity: Number(row.days_since_activity ?? 0),
      lastActivityAt: row.last_touch_at ?? null,
      activeDealCount: Number(row.active_deal_count ?? 0),
    })),
  };
}

// ---------------------------------------------------------------------------
// 11. Regional and Rep Ownership Overview
// ---------------------------------------------------------------------------

export interface RegionalOwnershipRegionRollup {
  regionId: string | null;
  regionName: string;
  dealCount: number;
  pipelineValue: number;
  staleDealCount: number;
}

export interface RegionalOwnershipRepRollup {
  repId: string;
  repName: string;
  dealCount: number;
  pipelineValue: number;
  activityCount: number;
  staleDealCount: number;
}

export interface RegionalOwnershipGap {
  gapType: "missing_assigned_rep" | "missing_region";
  count: number;
}

export interface RegionalOwnershipOverview {
  regionRollups: RegionalOwnershipRegionRollup[];
  repRollups: RegionalOwnershipRepRollup[];
  ownershipGaps: RegionalOwnershipGap[];
}

export async function getRegionalOwnershipOverview(
  tenantDb: TenantDb,
  options: AnalyticsFilterInput = {}
): Promise<RegionalOwnershipOverview> {
  const filters = normalizeAnalyticsFilters(options);
  if (!filters.officeId) {
    throw new Error("officeId is required for regional ownership reporting");
  }

  const officeFilter = sql`AND dsi.office_id = ${filters.officeId}`;
  const regionFilter = filters.regionId
    ? sql`AND d.region_id = ${filters.regionId}`
    : sql``;
  const repFilter = filters.repId
    ? sql`AND d.assigned_rep_id = ${filters.repId}`
    : sql``;
  const sourceFilter = filters.source
    ? sql`AND COALESCE(NULLIF(TRIM(d.source), ''), 'Unknown') = ${filters.source}`
    : sql``;
  const dateFilter = sql`
    AND d.created_at >= ${filters.from}::timestamptz
    AND d.created_at <= (${filters.to}::date + INTERVAL '1 day')::timestamptz
  `;

  const [regionResult, repDealResult, repActivityResult, gapResult] = await Promise.all([
    tenantDb.execute(sql`
      SELECT
        d.region_id,
        COALESCE(rc.name, 'Unassigned') AS region_name,
        COUNT(*) FILTER (WHERE d.is_active = true AND NOT psc.is_terminal)::int AS deal_count,
        COALESCE(SUM(
          COALESCE(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0)
        ) FILTER (WHERE d.is_active = true AND NOT psc.is_terminal), 0)::numeric AS pipeline_value,
        COUNT(*) FILTER (
          WHERE d.is_active = true
            AND NOT psc.is_terminal
            AND psc.stale_threshold_days IS NOT NULL
            AND EXTRACT(DAY FROM NOW() - d.stage_entered_at) > psc.stale_threshold_days
        )::int AS stale_deal_count
      FROM deals d
      LEFT JOIN deal_scoping_intake dsi ON dsi.deal_id = d.id
      LEFT JOIN region_config rc ON rc.id = d.region_id
      JOIN pipeline_stage_config psc ON psc.id = d.stage_id
      WHERE TRUE
        ${dateFilter}
        ${officeFilter}
        ${regionFilter}
        ${repFilter}
        ${sourceFilter}
      GROUP BY d.region_id, rc.name
      ORDER BY pipeline_value DESC, region_name ASC
    `),
    tenantDb.execute(sql`
      SELECT
        d.assigned_rep_id AS rep_id,
        COALESCE(u.display_name, 'Unassigned') AS rep_name,
        COUNT(*) FILTER (WHERE d.is_active = true AND NOT psc.is_terminal)::int AS deal_count,
        COALESCE(SUM(
          COALESCE(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0)
        ) FILTER (WHERE d.is_active = true AND NOT psc.is_terminal), 0)::numeric AS pipeline_value,
        COUNT(*) FILTER (
          WHERE d.is_active = true
            AND NOT psc.is_terminal
            AND psc.stale_threshold_days IS NOT NULL
            AND EXTRACT(DAY FROM NOW() - d.stage_entered_at) > psc.stale_threshold_days
        )::int AS stale_deal_count
      FROM deals d
      LEFT JOIN deal_scoping_intake dsi ON dsi.deal_id = d.id
      LEFT JOIN users u ON u.id = d.assigned_rep_id
      LEFT JOIN pipeline_stage_config psc ON psc.id = d.stage_id
      WHERE TRUE
        ${dateFilter}
        ${officeFilter}
        ${regionFilter}
        ${repFilter}
        ${sourceFilter}
      GROUP BY d.assigned_rep_id, u.display_name
      ORDER BY pipeline_value DESC, rep_name ASC
    `),
    tenantDb.execute(sql`
      SELECT
        d.assigned_rep_id AS rep_id,
        COALESCE(u.display_name, 'Unassigned') AS rep_name,
        COUNT(*)::int AS activity_count
      FROM activities a
      JOIN deals d ON d.id = a.deal_id
      LEFT JOIN deal_scoping_intake dsi ON dsi.deal_id = d.id
      LEFT JOIN users u ON u.id = d.assigned_rep_id
      WHERE TRUE
        ${dateFilter}
        ${officeFilter}
        ${regionFilter}
        ${repFilter}
        ${sourceFilter}
      GROUP BY d.assigned_rep_id, u.display_name
      ORDER BY activity_count DESC, rep_name ASC
    `),
    tenantDb.execute(sql`
      SELECT gap_type, COUNT(*)::int AS count
      FROM (
        SELECT 'missing_assigned_rep' AS gap_type
        FROM deals d
        LEFT JOIN deal_scoping_intake dsi ON dsi.deal_id = d.id
        WHERE TRUE
          ${dateFilter}
          ${officeFilter}
          ${sourceFilter}
          AND d.assigned_rep_id IS NULL
        UNION ALL
        SELECT 'missing_region' AS gap_type
        FROM deals d
        LEFT JOIN deal_scoping_intake dsi ON dsi.deal_id = d.id
        WHERE TRUE
          ${dateFilter}
          ${officeFilter}
          ${repFilter}
          ${sourceFilter}
          AND d.region_id IS NULL
      ) ownership_gaps
      GROUP BY gap_type
      ORDER BY gap_type ASC
    `),
  ]);

  const regionRows = (regionResult as any).rows ?? regionResult;
  const repDealRows = (repDealResult as any).rows ?? repDealResult;
  const repActivityRows = (repActivityResult as any).rows ?? repActivityResult;
  const gapRows = (gapResult as any).rows ?? gapResult;
  const activityCountByRep = new Map<string, number>();
  for (const row of repActivityRows as any[]) {
    if (row.rep_id) {
      activityCountByRep.set(row.rep_id, Number(row.activity_count ?? 0));
    }
  }

  return {
    regionRollups: regionRows.map((row: any) => ({
      regionId: row.region_id ?? null,
      regionName: row.region_name,
      dealCount: Number(row.deal_count ?? 0),
      pipelineValue: Number(row.pipeline_value ?? 0),
      staleDealCount: Number(row.stale_deal_count ?? 0),
    })),
    repRollups: repDealRows
      .filter((row: any) => row.rep_id)
      .map((row: any) => ({
        repId: row.rep_id,
        repName: row.rep_name,
        dealCount: Number(row.deal_count ?? 0),
        pipelineValue: Number(row.pipeline_value ?? 0),
        activityCount: activityCountByRep.get(row.rep_id) ?? 0,
        staleDealCount: Number(row.stale_deal_count ?? 0),
      })),
    ownershipGaps: gapRows.map((row: any) => ({
      gapType: row.gap_type,
      count: Number(row.count ?? 0),
    })),
  };
}

// ---------------------------------------------------------------------------
// 11. Follow-up Compliance Rate
// ---------------------------------------------------------------------------

/**
 * Follow-up compliance: percentage of follow_up tasks completed on time (before due_date)
 * for a specific rep within the date range.
 */
export async function getFollowUpCompliance(
  tenantDb: TenantDb,
  repId: string,
  options: { from?: string; to?: string } = {}
): Promise<{ total: number; onTime: number; complianceRate: number }> {
  const { from, to } = defaultDateRange(options.from, options.to);

  const result = await tenantDb.execute(sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (
        WHERE t.status = 'completed'
          AND (t.completed_at::date <= t.due_date OR t.due_date IS NULL)
      )::int AS on_time
    FROM tasks t
    WHERE t.assigned_to = ${repId}
      AND t.type = 'follow_up'
      AND t.created_at >= ${from}::timestamptz
      AND t.created_at <= (${to}::date + INTERVAL '1 day')::timestamptz
      AND t.status IN ('completed', 'dismissed')
  `);

  const rows = (result as any).rows ?? result;
  const row = rows[0] ?? {};
  const total = Number(row.total ?? 0);
  const onTime = Number(row.on_time ?? 0);

  return {
    total,
    onTime,
    complianceRate: total > 0 ? Math.round((onTime / total) * 100) : 100,
  };
}

// ---------------------------------------------------------------------------
// 12. DD vs True Pipeline Value
// ---------------------------------------------------------------------------

export interface DdVsPipelineRow {
  ddValue: number;
  ddCount: number;
  pipelineValue: number;
  pipelineCount: number;
  totalValue: number;
  totalCount: number;
}

/**
 * Compares DD-stage deal values against active pipeline (non-DD) deal values.
 */
export async function getDdVsPipeline(
  tenantDb: TenantDb
): Promise<DdVsPipelineRow> {
  const result = await tenantDb.execute(sql`
    SELECT
      COALESCE(SUM(
        COALESCE(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0)
      ) FILTER (WHERE NOT psc.is_active_pipeline AND NOT psc.is_terminal), 0)::numeric AS dd_value,
      COUNT(*) FILTER (WHERE NOT psc.is_active_pipeline AND NOT psc.is_terminal)::int AS dd_count,
      COALESCE(SUM(
        COALESCE(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0)
      ) FILTER (WHERE psc.is_active_pipeline AND NOT psc.is_terminal), 0)::numeric AS pipeline_value,
      COUNT(*) FILTER (WHERE psc.is_active_pipeline AND NOT psc.is_terminal)::int AS pipeline_count
    FROM deals d
    JOIN pipeline_stage_config psc ON psc.id = d.stage_id
    WHERE d.is_active = true
  `);

  const rows = (result as any).rows ?? result;
  const row = rows[0] ?? {};

  const ddValue = Number(row.dd_value ?? 0);
  const ddCount = Number(row.dd_count ?? 0);
  const pipelineValue = Number(row.pipeline_value ?? 0);
  const pipelineCount = Number(row.pipeline_count ?? 0);

  return {
    ddValue,
    ddCount,
    pipelineValue,
    pipelineCount,
    totalValue: ddValue + pipelineValue,
    totalCount: ddCount + pipelineCount,
  };
}

// ---------------------------------------------------------------------------
// 13. Closed-Won Summary Report
// ---------------------------------------------------------------------------

export interface ClosedWonSummaryRepRow {
  repId: string;
  repName: string;
  dealCount: number;
  totalValue: number;
}

export interface ClosedWonSummaryProjectTypeRow {
  projectTypeId: string | null;
  projectTypeName: string;
  dealCount: number;
  totalValue: number;
}

export interface ClosedWonSummary {
  totalWonDeals: number;
  totalWonValue: number;
  avgCycleTimeDays: number;
  byRep: ClosedWonSummaryRepRow[];
  byProjectType: ClosedWonSummaryProjectTypeRow[];
}

/**
 * Closed-won summary: total deals, total value, average cycle time,
 * breakdown by rep and by project type.
 * Date filter uses actual_close_date.
 */
export async function getClosedWonSummary(
  tenantDb: TenantDb,
  options: { from?: string; to?: string } = {}
): Promise<ClosedWonSummary> {
  const { from, to } = defaultDateRange(options.from, options.to);

  const [totalsResult, repResult, typeResult] = await Promise.all([
    tenantDb.execute(sql`
      SELECT
        COUNT(*)::int AS total_won_deals,
        COALESCE(SUM(
          COALESCE(d.awarded_amount, d.bid_estimate, 0)
        ), 0)::numeric AS total_won_value,
        COALESCE(AVG(
          EXTRACT(DAY FROM d.actual_close_date::timestamp - d.created_at)
        ), 0)::numeric AS avg_cycle_time_days
      FROM deals d
      JOIN pipeline_stage_config psc ON psc.id = d.stage_id
      WHERE psc.slug = 'closed_won'
        AND d.actual_close_date >= ${from}::date
        AND d.actual_close_date <= ${to}::date
    `),
    tenantDb.execute(sql`
      SELECT
        d.assigned_rep_id AS rep_id,
        u.display_name AS rep_name,
        COUNT(*)::int AS deal_count,
        COALESCE(SUM(
          COALESCE(d.awarded_amount, d.bid_estimate, 0)
        ), 0)::numeric AS total_value
      FROM deals d
      JOIN pipeline_stage_config psc ON psc.id = d.stage_id
      JOIN users u ON u.id = d.assigned_rep_id
      WHERE psc.slug = 'closed_won'
        AND d.actual_close_date >= ${from}::date
        AND d.actual_close_date <= ${to}::date
      GROUP BY d.assigned_rep_id, u.display_name
      ORDER BY total_value DESC
    `),
    tenantDb.execute(sql`
      SELECT
        d.project_type_id,
        COALESCE(ptc.name, 'Unspecified') AS project_type_name,
        COUNT(*)::int AS deal_count,
        COALESCE(SUM(
          COALESCE(d.awarded_amount, d.bid_estimate, 0)
        ), 0)::numeric AS total_value
      FROM deals d
      LEFT JOIN project_type_config ptc ON ptc.id = d.project_type_id
      JOIN pipeline_stage_config psc ON psc.id = d.stage_id
      WHERE psc.slug = 'closed_won'
        AND d.actual_close_date >= ${from}::date
        AND d.actual_close_date <= ${to}::date
      GROUP BY d.project_type_id, ptc.name
      ORDER BY total_value DESC
    `),
  ]);

  const totalsRows = (totalsResult as any).rows ?? totalsResult;
  const repRows = (repResult as any).rows ?? repResult;
  const typeRows = (typeResult as any).rows ?? typeResult;

  const t = totalsRows[0] ?? {};

  return {
    totalWonDeals: Number(t.total_won_deals ?? 0),
    totalWonValue: Number(t.total_won_value ?? 0),
    avgCycleTimeDays: Math.round(Number(t.avg_cycle_time_days ?? 0)),
    byRep: repRows.map((r: any) => ({
      repId: r.rep_id,
      repName: r.rep_name,
      dealCount: Number(r.deal_count ?? 0),
      totalValue: Number(r.total_value ?? 0),
    })),
    byProjectType: typeRows.map((r: any) => ({
      projectTypeId: r.project_type_id,
      projectTypeName: r.project_type_name,
      dealCount: Number(r.deal_count ?? 0),
      totalValue: Number(r.total_value ?? 0),
    })),
  };
}

// ---------------------------------------------------------------------------
// 14. Pipeline by Rep
// ---------------------------------------------------------------------------

export interface PipelineByRepStageRow {
  stageId: string;
  stageName: string;
  dealCount: number;
  totalValue: number;
}

export interface PipelineByRepRow {
  repId: string;
  repName: string;
  stages: PipelineByRepStageRow[];
}

/**
 * Active pipeline grouped by rep, then by stage.
 * Only includes active non-terminal deals.
 */
export async function getPipelineByRep(
  tenantDb: TenantDb,
  options: { repId?: string } = {}
): Promise<PipelineByRepRow[]> {
  const repFilter = options.repId
    ? sql`AND d.assigned_rep_id = ${options.repId}`
    : sql``;

  const result = await tenantDb.execute(sql`
    SELECT
      d.assigned_rep_id AS rep_id,
      u.display_name AS rep_name,
      d.stage_id,
      psc.name AS stage_name,
      COUNT(*)::int AS deal_count,
      COALESCE(SUM(
        COALESCE(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0)
      ), 0)::numeric AS total_value
    FROM deals d
    JOIN pipeline_stage_config psc ON psc.id = d.stage_id
    JOIN users u ON u.id = d.assigned_rep_id
    WHERE d.is_active = true
      AND psc.is_terminal = false
      ${repFilter}
    GROUP BY d.assigned_rep_id, u.display_name, d.stage_id, psc.name, psc.display_order
    ORDER BY u.display_name ASC, psc.display_order ASC
  `);

  const rows = (result as any).rows ?? result;

  // Group by rep
  const repMap = new Map<string, PipelineByRepRow>();
  for (const r of rows) {
    const repId = r.rep_id;
    if (!repMap.has(repId)) {
      repMap.set(repId, { repId, repName: r.rep_name, stages: [] });
    }
    repMap.get(repId)!.stages.push({
      stageId: r.stage_id,
      stageName: r.stage_name,
      dealCount: Number(r.deal_count ?? 0),
      totalValue: Number(r.total_value ?? 0),
    });
  }

  return Array.from(repMap.values());
}

// ---------------------------------------------------------------------------
// 15. Unified Workflow Overview
// ---------------------------------------------------------------------------

export interface UnifiedLeadPipelineSummaryRow {
  workflowRoute: WorkflowRoute;
  validationStatus: DealScopingIntakeStatus | string;
  intakeCount: number;
}

export interface UnifiedRouteRollupRow {
  workflowRoute: WorkflowRoute;
  dealCount: number;
  totalValue: number;
  staleDealCount: number;
}

export interface UnifiedCompanyRollupRow {
  companyId: string | null;
  companyName: string;
  leadCount: number;
  propertyCount: number;
  dealCount: number;
  activeDealCount: number;
  standardDealCount: number;
  serviceDealCount: number;
  totalValue: number;
}

export interface UnifiedRepActivitySplitRow {
  repId: string;
  repName: string;
  leadStageCalls: number;
  leadStageEmails: number;
  leadStageMeetings: number;
  leadStageNotes: number;
  dealStageCalls: number;
  dealStageEmails: number;
  dealStageMeetings: number;
  dealStageNotes: number;
  totalLeadStageActivities: number;
  totalDealStageActivities: number;
}

export interface UnifiedStaleLeadRow {
  leadId: string;
  leadName: string;
  companyName: string;
  workflowRoute: WorkflowRoute;
  validationStatus: DealScopingIntakeStatus | string;
  ageInDays: number;
  staleThresholdDays: number;
}

export interface UnifiedStaleDealRow {
  dealId: string;
  dealNumber: string;
  dealName: string;
  stageName: string;
  workflowRoute: WorkflowRoute;
  repName: string;
  daysInStage: number;
  staleThresholdDays: number;
  dealValue: number;
}

export interface UnifiedWorkflowOverview {
  leadPipelineSummary: UnifiedLeadPipelineSummaryRow[];
  standardVsServiceRollups: UnifiedRouteRollupRow[];
  companyRollups: UnifiedCompanyRollupRow[];
  repActivitySplit: UnifiedRepActivitySplitRow[];
  staleLeads: UnifiedStaleLeadRow[];
  staleDeals: UnifiedStaleDealRow[];
}

export async function getUnifiedWorkflowOverview(
  tenantDb: TenantDb,
  options: AnalyticsFilterInput = {}
): Promise<UnifiedWorkflowOverview> {
  const filters = normalizeAnalyticsFilters(options);
  const leadRepFilter = filters.repId
    ? sql`AND (dsi.created_by = ${filters.repId} OR dsi.last_edited_by = ${filters.repId})`
    : sql``;
  const leadOfficeFilter = filters.officeId
    ? sql`AND dsi.office_id = ${filters.officeId}`
    : sql``;
  const leadRegionFilter = filters.regionId
    ? sql`AND d.region_id = ${filters.regionId}`
    : sql``;
  const leadSourceFilter = filters.source
    ? sql`AND COALESCE(NULLIF(TRIM(d.source), ''), 'Unknown') = ${filters.source}`
    : sql``;
  const dealRepFilter = filters.repId
    ? sql`AND d.assigned_rep_id = ${filters.repId}`
    : sql``;
  const dealOfficeFilter = filters.officeId
    ? sql`AND dsi.office_id = ${filters.officeId}`
    : sql``;
  const dealRegionFilter = filters.regionId
    ? sql`AND d.region_id = ${filters.regionId}`
    : sql``;
  const dealSourceFilter = filters.source
    ? sql`AND COALESCE(NULLIF(TRIM(d.source), ''), 'Unknown') = ${filters.source}`
    : sql``;
  const activityRepFilter = filters.repId
    ? sql`AND a.responsible_user_id = ${filters.repId}`
    : sql``;
  const activityOfficeFilter = filters.officeId
    ? sql`AND dsi.office_id = ${filters.officeId}`
    : sql``;
  const activityRegionFilter = filters.regionId
    ? sql`AND d.region_id = ${filters.regionId}`
    : sql``;
  const activitySourceFilter = filters.source
    ? sql`AND COALESCE(NULLIF(TRIM(d.source), ''), 'Unknown') = ${filters.source}`
    : sql``;
  const staleLeadOfficeFilter = filters.officeId
    ? sql`AND dsi.office_id = ${filters.officeId}`
    : sql``;
  const staleLeadRegionFilter = filters.regionId
    ? sql`AND d.region_id = ${filters.regionId}`
    : sql``;
  const staleLeadSourceFilter = filters.source
    ? sql`AND COALESCE(NULLIF(TRIM(d.source), ''), 'Unknown') = ${filters.source}`
    : sql``;
  const staleDealOfficeFilter = filters.officeId
    ? sql`AND dsi.office_id = ${filters.officeId}`
    : sql``;
  const staleDealRegionFilter = filters.regionId
    ? sql`AND d.region_id = ${filters.regionId}`
    : sql``;
  const staleDealSourceFilter = filters.source
    ? sql`AND COALESCE(NULLIF(TRIM(d.source), ''), 'Unknown') = ${filters.source}`
    : sql``;

  const [
    leadPipelineResult,
    routeRollupResult,
    companyRollupResult,
    repActivityResult,
    staleLeadResult,
    staleDealResult,
  ] = await Promise.all([
    tenantDb.execute(sql`
      SELECT
        dsi.workflow_route_snapshot AS workflow_route,
        dsi.status AS validation_status,
        COUNT(*)::int AS intake_count
      FROM deal_scoping_intake dsi
      JOIN deals d ON d.id = dsi.deal_id
      WHERE dsi.workflow_route_snapshot IN ('estimating', 'service')
        ${leadRepFilter}
        ${leadOfficeFilter}
        ${leadRegionFilter}
        ${leadSourceFilter}
      GROUP BY dsi.workflow_route_snapshot, dsi.status
      ORDER BY dsi.workflow_route_snapshot ASC, dsi.status ASC
    `),
    tenantDb.execute(sql`
      SELECT
        d.workflow_route,
        COUNT(*) FILTER (WHERE d.is_active = true AND NOT psc.is_terminal)::int AS deal_count,
        COALESCE(SUM(
          COALESCE(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0)
        ) FILTER (WHERE d.is_active = true AND NOT psc.is_terminal), 0)::numeric AS total_value,
        COUNT(*) FILTER (
          WHERE d.is_active = true
            AND NOT psc.is_terminal
            AND psc.stale_threshold_days IS NOT NULL
            AND EXTRACT(DAY FROM NOW() - d.stage_entered_at) > psc.stale_threshold_days
        )::int AS stale_deal_count
      FROM deals d
      JOIN pipeline_stage_config psc ON psc.id = d.stage_id
      LEFT JOIN deal_scoping_intake dsi ON dsi.deal_id = d.id
      WHERE d.workflow_route IN ('estimating', 'service')
        ${dealRepFilter}
        ${dealOfficeFilter}
        ${dealRegionFilter}
        ${dealSourceFilter}
      GROUP BY d.workflow_route
      ORDER BY d.workflow_route ASC
    `),
    tenantDb.execute(sql`
      SELECT
        d.company_id,
        COALESCE(c.name, 'Unassigned') AS company_name,
        COUNT(DISTINCT dsi.id)::int AS lead_count,
        COUNT(DISTINCT CASE
          WHEN COALESCE(d.property_address, d.property_city, d.property_state, d.property_zip) IS NOT NULL
          THEN
            COALESCE(LOWER(NULLIF(TRIM(c.name), '')), '') || '|' ||
            COALESCE(LOWER(NULLIF(TRIM(d.property_address), '')), '') || '|' ||
            COALESCE(LOWER(NULLIF(TRIM(d.property_city), '')), '') || '|' ||
            COALESCE(LOWER(NULLIF(TRIM(d.property_state), '')), '') || '|' ||
            COALESCE(LOWER(NULLIF(TRIM(d.property_zip), '')), '')
          END)::int AS property_count,
        COUNT(*)::int AS deal_count,
        COUNT(*) FILTER (WHERE d.is_active = true AND NOT psc.is_terminal)::int AS active_deal_count,
        COUNT(*) FILTER (WHERE d.workflow_route = 'estimating' AND NOT psc.is_terminal)::int AS standard_deal_count,
        COUNT(*) FILTER (WHERE d.workflow_route = 'service' AND NOT psc.is_terminal)::int AS service_deal_count,
        COALESCE(SUM(
          COALESCE(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0)
        ), 0)::numeric AS total_value
      FROM deals d
      LEFT JOIN companies c ON c.id = d.company_id
      LEFT JOIN deal_scoping_intake dsi ON dsi.deal_id = d.id
      JOIN pipeline_stage_config psc ON psc.id = d.stage_id
      WHERE TRUE
        ${dealRepFilter}
        ${dealOfficeFilter}
        ${dealRegionFilter}
        ${dealSourceFilter}
      GROUP BY d.company_id, c.name
      ORDER BY total_value DESC, company_name ASC
    `),
    tenantDb.execute(sql`
      WITH activity_stage AS (
        SELECT
          a.responsible_user_id AS rep_id,
          u.display_name AS rep_name,
          CASE
            WHEN dsi.id IS NULL THEN 'deal'
            WHEN dsi.activated_at IS NOT NULL AND a.occurred_at >= dsi.activated_at THEN 'deal'
            ELSE 'lead'
          END AS stage_group,
          a.type
        FROM activities a
        JOIN users u ON u.id = a.responsible_user_id
        JOIN deals d ON d.id = a.deal_id
        LEFT JOIN deal_scoping_intake dsi ON dsi.deal_id = d.id
        WHERE a.occurred_at <= (NOW() + INTERVAL '1 day')
          ${activityRepFilter}
          ${activityOfficeFilter}
          ${activityRegionFilter}
          ${activitySourceFilter}
      )
      SELECT
        rep_id,
        rep_name,
        COUNT(*) FILTER (WHERE stage_group = 'lead' AND type = 'call')::int AS lead_stage_calls,
        COUNT(*) FILTER (WHERE stage_group = 'lead' AND type = 'email')::int AS lead_stage_emails,
        COUNT(*) FILTER (WHERE stage_group = 'lead' AND type = 'meeting')::int AS lead_stage_meetings,
        COUNT(*) FILTER (WHERE stage_group = 'lead' AND type = 'note')::int AS lead_stage_notes,
        COUNT(*) FILTER (WHERE stage_group = 'deal' AND type = 'call')::int AS deal_stage_calls,
        COUNT(*) FILTER (WHERE stage_group = 'deal' AND type = 'email')::int AS deal_stage_emails,
        COUNT(*) FILTER (WHERE stage_group = 'deal' AND type = 'meeting')::int AS deal_stage_meetings,
        COUNT(*) FILTER (WHERE stage_group = 'deal' AND type = 'note')::int AS deal_stage_notes,
        COUNT(*) FILTER (WHERE stage_group = 'lead')::int AS total_lead_stage_activities,
        COUNT(*) FILTER (WHERE stage_group = 'deal')::int AS total_deal_stage_activities
      FROM activity_stage
      GROUP BY rep_id, rep_name
      ORDER BY total_deal_stage_activities DESC, total_lead_stage_activities DESC, rep_name ASC
    `),
    tenantDb.execute(sql`
      SELECT
        dsi.id AS lead_id,
        d.name AS lead_name,
        COALESCE(c.name, 'Unassigned') AS company_name,
        dsi.workflow_route_snapshot AS workflow_route,
        dsi.status AS validation_status,
        EXTRACT(DAY FROM NOW() - COALESCE(dsi.first_ready_at, dsi.last_autosaved_at, dsi.created_at))::int AS age_in_days,
        ${LEAD_STALE_THRESHOLD_DAYS}::int AS stale_threshold_days
      FROM deal_scoping_intake dsi
      JOIN deals d ON d.id = dsi.deal_id
      LEFT JOIN companies c ON c.id = d.company_id
      WHERE dsi.status IN ('draft', 'ready')
        AND EXTRACT(DAY FROM NOW() - COALESCE(dsi.first_ready_at, dsi.last_autosaved_at, dsi.created_at)) > ${LEAD_STALE_THRESHOLD_DAYS}
        ${leadRepFilter}
        ${staleLeadOfficeFilter}
        ${staleLeadRegionFilter}
        ${staleLeadSourceFilter}
      ORDER BY age_in_days DESC, lead_name ASC
    `),
    tenantDb.execute(sql`
      SELECT
        d.id AS deal_id,
        d.deal_number,
        d.name AS deal_name,
        psc.name AS stage_name,
        d.workflow_route,
        u.display_name AS rep_name,
        EXTRACT(DAY FROM NOW() - d.stage_entered_at)::int AS days_in_stage,
        psc.stale_threshold_days,
        COALESCE(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0)::numeric AS deal_value
      FROM deals d
      JOIN pipeline_stage_config psc ON psc.id = d.stage_id
      JOIN users u ON u.id = d.assigned_rep_id
      LEFT JOIN deal_scoping_intake dsi ON dsi.deal_id = d.id
      WHERE d.is_active = true
        AND psc.is_terminal = false
        AND psc.stale_threshold_days IS NOT NULL
        AND EXTRACT(DAY FROM NOW() - d.stage_entered_at) > psc.stale_threshold_days
        ${dealRepFilter}
        ${staleDealOfficeFilter}
        ${staleDealRegionFilter}
        ${staleDealSourceFilter}
      ORDER BY days_in_stage DESC, deal_name ASC
    `),
  ]);

  const leadRows = (leadPipelineResult as any).rows ?? leadPipelineResult;
  const routeRows = (routeRollupResult as any).rows ?? routeRollupResult;
  const companyRows = (companyRollupResult as any).rows ?? companyRollupResult;
  const activityRows = (repActivityResult as any).rows ?? repActivityResult;
  const staleLeadRows = (staleLeadResult as any).rows ?? staleLeadResult;
  const staleDealRows = (staleDealResult as any).rows ?? staleDealResult;

  return {
    leadPipelineSummary: leadRows.map((row: any) => ({
      workflowRoute: row.workflow_route,
      validationStatus: row.validation_status,
      intakeCount: Number(row.intake_count ?? 0),
    })),
    standardVsServiceRollups: routeRows.map((row: any) => ({
      workflowRoute: row.workflow_route,
      dealCount: Number(row.deal_count ?? 0),
      totalValue: Number(row.total_value ?? 0),
      staleDealCount: Number(row.stale_deal_count ?? 0),
    })),
    companyRollups: companyRows.map((row: any) => ({
      companyId: row.company_id ?? null,
      companyName: row.company_name,
      leadCount: Number(row.lead_count ?? 0),
      propertyCount: Number(row.property_count ?? 0),
      dealCount: Number(row.deal_count ?? 0),
      activeDealCount: Number(row.active_deal_count ?? 0),
      standardDealCount: Number(row.standard_deal_count ?? 0),
      serviceDealCount: Number(row.service_deal_count ?? 0),
      totalValue: Number(row.total_value ?? 0),
    })),
    repActivitySplit: activityRows.map((row: any) => ({
      repId: row.rep_id,
      repName: row.rep_name,
      leadStageCalls: Number(row.lead_stage_calls ?? 0),
      leadStageEmails: Number(row.lead_stage_emails ?? 0),
      leadStageMeetings: Number(row.lead_stage_meetings ?? 0),
      leadStageNotes: Number(row.lead_stage_notes ?? 0),
      dealStageCalls: Number(row.deal_stage_calls ?? 0),
      dealStageEmails: Number(row.deal_stage_emails ?? 0),
      dealStageMeetings: Number(row.deal_stage_meetings ?? 0),
      dealStageNotes: Number(row.deal_stage_notes ?? 0),
      totalLeadStageActivities: Number(row.total_lead_stage_activities ?? 0),
      totalDealStageActivities: Number(row.total_deal_stage_activities ?? 0),
    })),
    staleLeads: staleLeadRows.map((row: any) => ({
      leadId: row.lead_id,
      leadName: row.lead_name,
      companyName: row.company_name,
      workflowRoute: row.workflow_route,
      validationStatus: row.validation_status,
      ageInDays: Number(row.age_in_days ?? 0),
      staleThresholdDays: Number(row.stale_threshold_days ?? LEAD_STALE_THRESHOLD_DAYS),
    })),
    staleDeals: staleDealRows.map((row: any) => ({
      dealId: row.deal_id,
      dealNumber: row.deal_number,
      dealName: row.deal_name,
      stageName: row.stage_name,
      workflowRoute: row.workflow_route,
      repName: row.rep_name,
      daysInStage: Number(row.days_in_stage ?? 0),
      staleThresholdDays: Number(row.stale_threshold_days ?? 0),
      dealValue: Number(row.deal_value ?? 0),
    })),
  };
}

// ---------------------------------------------------------------------------
// 16. Custom Report Query Executor
// ---------------------------------------------------------------------------

export interface ReportConfig {
  entity: "deals" | "contacts" | "activities" | "tasks";
  filters: Array<{
    field: string;
    op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "like" | "is_null" | "is_not_null";
    value?: any;
  }>;
  columns: string[];
  sort?: { field: string; dir: "asc" | "desc" };
  chart_type?: "table" | "bar" | "pie" | "line";
}

/** Allowed columns per entity to prevent SQL injection via user-defined configs. */
const ALLOWED_COLUMNS: Record<string, string[]> = {
  deals: [
    "id", "deal_number", "name", "stage_id", "assigned_rep_id",
    "dd_estimate", "bid_estimate", "awarded_amount", "change_order_total",
    "project_type_id", "region_id", "source", "win_probability",
    "expected_close_date", "actual_close_date", "last_activity_at",
    "stage_entered_at", "is_active", "lost_reason_id", "lost_competitor",
    "lost_at", "created_at", "updated_at",
  ],
  contacts: [
    "id", "first_name", "last_name", "email", "phone", "mobile",
    "company_name", "job_title", "category", "city", "state",
    "touchpoint_count", "last_contacted_at", "first_outreach_completed",
    "is_active", "created_at", "updated_at",
  ],
  activities: [
    "id", "type", "responsible_user_id", "performed_by_user_id", "deal_id", "contact_id",
    "subject", "outcome", "duration_minutes", "occurred_at", "created_at",
  ],
  tasks: [
    "id", "title", "type", "priority", "status", "assigned_to",
    "deal_id", "contact_id", "due_date", "completed_at",
    "is_overdue", "created_at", "updated_at",
  ],
};

function normalizeReportField(entityTable: string, field: string): string {
  if (entityTable === "activities" && field === "user_id") {
    return "responsible_user_id";
  }
  return field;
}

/**
 * Execute a custom report query based on a saved report config.
 * Uses parameterized raw SQL built from the validated config.
 * Returns raw rows -- the frontend handles display formatting.
 */
export async function executeCustomReport(
  tenantDb: TenantDb,
  config: ReportConfig,
  pagination: { page: number; limit: number } = { page: 1, limit: 100 }
): Promise<{ rows: Record<string, any>[]; total: number }> {
  const entityTable = config.entity; // maps to table name directly
  const allowed = ALLOWED_COLUMNS[entityTable];
  if (!allowed) throw new Error(`Invalid entity: ${entityTable}`);

  // Validate columns
  const selectCols = config.columns.length > 0
    ? config.columns
        .map((c) => normalizeReportField(entityTable, c))
        .filter((c) => allowed.includes(c))
    : allowed.slice(0, 10); // default to first 10 columns

  if (selectCols.length === 0) throw new Error("No valid columns selected");

  // Build WHERE clause from filters using parameter binding for all values.
  const whereClauses: ReturnType<typeof sql>[] = [];
  for (const filter of config.filters) {
    const field = normalizeReportField(entityTable, filter.field);
    if (!allowed.includes(field)) continue; // skip unknown fields

    const col = sql.identifier(field);
    switch (filter.op) {
      case "eq":
        if (filter.value !== undefined) {
          whereClauses.push(sql`${col} = ${filter.value}`);
        }
        break;
      case "neq":
        if (filter.value !== undefined) {
          whereClauses.push(sql`${col} != ${filter.value}`);
        }
        break;
      case "gt":
        if (filter.value !== undefined) {
          whereClauses.push(sql`${col} > ${filter.value}`);
        }
        break;
      case "gte":
        if (filter.value !== undefined) {
          whereClauses.push(sql`${col} >= ${filter.value}`);
        }
        break;
      case "lt":
        if (filter.value !== undefined) {
          whereClauses.push(sql`${col} < ${filter.value}`);
        }
        break;
      case "lte":
        if (filter.value !== undefined) {
          whereClauses.push(sql`${col} <= ${filter.value}`);
        }
        break;
      case "in":
        if (Array.isArray(filter.value) && filter.value.length > 0) {
          whereClauses.push(sql`${col} IN ${filter.value}`);
        }
        break;
      case "like":
        if (filter.value !== undefined) {
          const escaped = String(filter.value).replace(/[\\%_]/g, "\\$&");
          whereClauses.push(sql`${col} ILIKE ${`%${escaped}%`} ESCAPE '\\'`);
        }
        break;
      case "is_null":
        whereClauses.push(sql`${col} IS NULL`);
        break;
      case "is_not_null":
        whereClauses.push(sql`${col} IS NOT NULL`);
        break;
    }
  }

  const whereClause = whereClauses.length > 0
    ? sql`WHERE ${sql.join(whereClauses, sql` AND `)}`
    : sql``;
  const selectList = sql.join(selectCols.map((c) => sql.identifier(c)), sql`, `);

  // Sort
  let orderClause = sql``;
  if (config.sort) {
    const sortField = normalizeReportField(entityTable, config.sort.field);
    if (allowed.includes(sortField)) {
    const dir = config.sort.dir === "asc" ? sql`ASC` : sql`DESC`;
      orderClause = sql`ORDER BY ${sql.identifier(sortField)} ${dir}`;
    }
  }

  const offset = (pagination.page - 1) * pagination.limit;

  const [countRes, dataRes] = await Promise.all([
    tenantDb.execute(sql`
      SELECT COUNT(*)::int AS total
      FROM ${sql.identifier(entityTable)}
      ${whereClause}
    `),
    tenantDb.execute(sql`
      SELECT ${selectList}
      FROM ${sql.identifier(entityTable)}
      ${whereClause}
      ${orderClause}
      LIMIT ${pagination.limit}
      OFFSET ${offset}
    `),
  ]);

  const countRows = (countRes as any).rows ?? countRes;
  const dataRows = (dataRes as any).rows ?? dataRes;

  return {
    rows: dataRows,
    total: Number(countRows[0]?.total ?? 0),
  };
}

// ---------------------------------------------------------------------------
// 15. Rep Performance Comparison (MoM / QoQ / YoY)
// ---------------------------------------------------------------------------

export interface PeriodMetrics {
  dealsWon: number;
  dealsLost: number;
  totalWonValue: number;
  activitiesLogged: number;
  winRate: number;
  avgDaysToClose: number;
}

export interface PeriodChange {
  dealsWon: number;
  dealsLost: number;
  totalWonValue: number;
  activitiesLogged: number;
  winRate: number;
  avgDaysToClose: number;
}

export interface RepPerformanceComparisonResult {
  reps: Array<{
    repId: string;
    repName: string;
    current: PeriodMetrics;
    previous: PeriodMetrics;
    change: PeriodChange;
  }>;
  periodLabel: { current: string; previous: string };
}

/** Calculate current + previous date ranges for a given period type. */
function getPeriodRanges(period: "month" | "quarter" | "year"): {
  current: { from: string; to: string };
  previous: { from: string; to: string };
  labels: { current: string; previous: string };
} {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-indexed

  const pad = (n: number) => String(n).padStart(2, "0");
  const lastDay = (y: number, m: number) => new Date(y, m + 1, 0).getDate();

  switch (period) {
    case "month": {
      const curFrom = `${year}-${pad(month + 1)}-01`;
      const curTo = `${year}-${pad(month + 1)}-${lastDay(year, month)}`;
      const prevMonth = month === 0 ? 11 : month - 1;
      const prevYear = month === 0 ? year - 1 : year;
      const prevFrom = `${prevYear}-${pad(prevMonth + 1)}-01`;
      const prevTo = `${prevYear}-${pad(prevMonth + 1)}-${lastDay(prevYear, prevMonth)}`;
      const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      return {
        current: { from: curFrom, to: curTo },
        previous: { from: prevFrom, to: prevTo },
        labels: {
          current: `${monthNames[month]} ${year}`,
          previous: `${monthNames[prevMonth]} ${prevYear}`,
        },
      };
    }
    case "quarter": {
      const curQ = Math.floor(month / 3);
      const curQStart = curQ * 3;
      const curFrom = `${year}-${pad(curQStart + 1)}-01`;
      const curTo = `${year}-${pad(curQStart + 3)}-${lastDay(year, curQStart + 2)}`;
      const prevQ = curQ === 0 ? 3 : curQ - 1;
      const prevYear = curQ === 0 ? year - 1 : year;
      const prevQStart = prevQ * 3;
      const prevFrom = `${prevYear}-${pad(prevQStart + 1)}-01`;
      const prevTo = `${prevYear}-${pad(prevQStart + 3)}-${lastDay(prevYear, prevQStart + 2)}`;
      return {
        current: { from: curFrom, to: curTo },
        previous: { from: prevFrom, to: prevTo },
        labels: {
          current: `Q${curQ + 1} ${year}`,
          previous: `Q${prevQ + 1} ${prevYear}`,
        },
      };
    }
    case "year": {
      return {
        current: { from: `${year}-01-01`, to: `${year}-12-31` },
        previous: { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` },
        labels: {
          current: String(year),
          previous: String(year - 1),
        },
      };
    }
  }
}

function computeChange(current: PeriodMetrics, previous: PeriodMetrics): PeriodChange {
  return {
    dealsWon: current.dealsWon - previous.dealsWon,
    dealsLost: current.dealsLost - previous.dealsLost,
    totalWonValue: current.totalWonValue - previous.totalWonValue,
    activitiesLogged: current.activitiesLogged - previous.activitiesLogged,
    winRate: Math.round((current.winRate - previous.winRate) * 100) / 100,
    avgDaysToClose: Math.round((current.avgDaysToClose - previous.avgDaysToClose) * 100) / 100,
  };
}

/**
 * Period-over-period performance comparison per rep.
 * Supports month, quarter, and year comparisons.
 */
export async function getRepPerformanceComparison(
  tenantDb: TenantDb,
  period: "month" | "quarter" | "year"
): Promise<RepPerformanceComparisonResult> {
  const { current, previous, labels } = getPeriodRanges(period);

  // Query deals won/lost and avg days to close for both periods in one query
  const dealResult = await tenantDb.execute(sql`
    SELECT
      d.assigned_rep_id AS rep_id,
      u.display_name AS rep_name,
      COUNT(*) FILTER (
        WHERE psc.slug = 'closed_won'
          AND dsh.created_at >= ${current.from}::timestamptz
          AND dsh.created_at <= (${current.to}::date + INTERVAL '1 day')::timestamptz
      )::int AS cur_won,
      COUNT(*) FILTER (
        WHERE psc.slug = 'closed_lost'
          AND dsh.created_at >= ${current.from}::timestamptz
          AND dsh.created_at <= (${current.to}::date + INTERVAL '1 day')::timestamptz
      )::int AS cur_lost,
      COALESCE(SUM(
        COALESCE(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0)
      ) FILTER (
        WHERE psc.slug = 'closed_won'
          AND dsh.created_at >= ${current.from}::timestamptz
          AND dsh.created_at <= (${current.to}::date + INTERVAL '1 day')::timestamptz
      ), 0)::numeric AS cur_won_value,
      COALESCE(AVG(EXTRACT(EPOCH FROM dsh.duration_in_previous_stage) / 86400) FILTER (
        WHERE psc.slug = 'closed_won'
          AND dsh.created_at >= ${current.from}::timestamptz
          AND dsh.created_at <= (${current.to}::date + INTERVAL '1 day')::timestamptz
      ), 0)::numeric AS cur_avg_days,
      COUNT(*) FILTER (
        WHERE psc.slug = 'closed_won'
          AND dsh.created_at >= ${previous.from}::timestamptz
          AND dsh.created_at <= (${previous.to}::date + INTERVAL '1 day')::timestamptz
      )::int AS prev_won,
      COUNT(*) FILTER (
        WHERE psc.slug = 'closed_lost'
          AND dsh.created_at >= ${previous.from}::timestamptz
          AND dsh.created_at <= (${previous.to}::date + INTERVAL '1 day')::timestamptz
      )::int AS prev_lost,
      COALESCE(SUM(
        COALESCE(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0)
      ) FILTER (
        WHERE psc.slug = 'closed_won'
          AND dsh.created_at >= ${previous.from}::timestamptz
          AND dsh.created_at <= (${previous.to}::date + INTERVAL '1 day')::timestamptz
      ), 0)::numeric AS prev_won_value,
      COALESCE(AVG(EXTRACT(EPOCH FROM dsh.duration_in_previous_stage) / 86400) FILTER (
        WHERE psc.slug = 'closed_won'
          AND dsh.created_at >= ${previous.from}::timestamptz
          AND dsh.created_at <= (${previous.to}::date + INTERVAL '1 day')::timestamptz
      ), 0)::numeric AS prev_avg_days
    FROM deal_stage_history dsh
    JOIN deals d ON d.id = dsh.deal_id
    JOIN pipeline_stage_config psc ON psc.id = dsh.to_stage_id
    JOIN users u ON u.id = d.assigned_rep_id
    WHERE psc.is_terminal = true
      AND (
        (dsh.created_at >= ${previous.from}::timestamptz AND dsh.created_at <= (${current.to}::date + INTERVAL '1 day')::timestamptz)
      )
    GROUP BY d.assigned_rep_id, u.display_name
    ORDER BY u.display_name ASC
  `);

  // Query activities for both periods
  const activityResult = await tenantDb.execute(sql`
    SELECT
      a.responsible_user_id AS rep_id,
      COUNT(*) FILTER (
        WHERE a.occurred_at >= ${current.from}::timestamptz
          AND a.occurred_at <= (${current.to}::date + INTERVAL '1 day')::timestamptz
      )::int AS cur_activities,
      COUNT(*) FILTER (
        WHERE a.occurred_at >= ${previous.from}::timestamptz
          AND a.occurred_at <= (${previous.to}::date + INTERVAL '1 day')::timestamptz
      )::int AS prev_activities
    FROM activities a
    WHERE a.occurred_at >= ${previous.from}::timestamptz
      AND a.occurred_at <= (${current.to}::date + INTERVAL '1 day')::timestamptz
    GROUP BY a.responsible_user_id
  `);

  const dealRows = (dealResult as any).rows ?? dealResult;
  const actRows = (activityResult as any).rows ?? activityResult;

  // Build activity map
  const actMap = new Map<string, { cur: number; prev: number }>();
  for (const r of actRows) {
    actMap.set(r.rep_id, {
      cur: Number(r.cur_activities ?? 0),
      prev: Number(r.prev_activities ?? 0),
    });
  }

  const reps = dealRows.map((r: any) => {
    const curWon = Number(r.cur_won ?? 0);
    const curLost = Number(r.cur_lost ?? 0);
    const curTotal = curWon + curLost;
    const prevWon = Number(r.prev_won ?? 0);
    const prevLost = Number(r.prev_lost ?? 0);
    const prevTotal = prevWon + prevLost;
    const act = actMap.get(r.rep_id) ?? { cur: 0, prev: 0 };

    const currentMetrics: PeriodMetrics = {
      dealsWon: curWon,
      dealsLost: curLost,
      totalWonValue: Number(r.cur_won_value ?? 0),
      activitiesLogged: act.cur,
      winRate: curTotal > 0 ? Math.round((curWon / curTotal) * 100) : 0,
      avgDaysToClose: Math.round(Number(r.cur_avg_days ?? 0)),
    };

    const previousMetrics: PeriodMetrics = {
      dealsWon: prevWon,
      dealsLost: prevLost,
      totalWonValue: Number(r.prev_won_value ?? 0),
      activitiesLogged: act.prev,
      winRate: prevTotal > 0 ? Math.round((prevWon / prevTotal) * 100) : 0,
      avgDaysToClose: Math.round(Number(r.prev_avg_days ?? 0)),
    };

    return {
      repId: r.rep_id,
      repName: r.rep_name,
      current: currentMetrics,
      previous: previousMetrics,
      change: computeChange(currentMetrics, previousMetrics),
    };
  });

  return { reps, periodLabel: labels };
}
