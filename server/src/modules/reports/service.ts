import { eq, and, sql, gte, lte, inArray, isNull, not, asc, desc } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  deals,
  dealStageHistory,
  activities,
  tasks,
  pipelineStageConfig,
  users,
  lostDealReasons,
  projectTypeConfig,
} from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
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
      AND d.stage_id = ANY(${stageIds})
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
      a.user_id AS rep_id,
      u.display_name AS rep_name,
      COUNT(*) FILTER (WHERE a.type = 'call')::int AS calls,
      COUNT(*) FILTER (WHERE a.type = 'email')::int AS emails,
      COUNT(*) FILTER (WHERE a.type = 'meeting')::int AS meetings,
      COUNT(*) FILTER (WHERE a.type = 'note')::int AS notes,
      COUNT(*) FILTER (WHERE a.type = 'task_completed')::int AS tasks_completed,
      COUNT(*)::int AS total
    FROM activities a
    JOIN users u ON u.id = a.user_id
    WHERE a.occurred_at >= ${from}::timestamptz
      AND a.occurred_at <= (${to}::date + INTERVAL '1 day')::timestamptz
    GROUP BY a.user_id, u.display_name
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
  totalDeals: number;
  activeDeals: number;
  wonDeals: number;
  lostDeals: number;
  pipelineValue: number;
  wonValue: number;
  winRate: number;
}

/**
 * Lead source performance: deals won, pipeline value, and win rate by source.
 */
export async function getLeadSourceROI(
  tenantDb: TenantDb,
  options: { from?: string; to?: string } = {}
): Promise<LeadSourceROIRow[]> {
  const { from, to } = defaultDateRange(options.from, options.to);

  const result = await tenantDb.execute(sql`
    SELECT
      COALESCE(d.source, 'Unknown') AS source,
      COUNT(*)::int AS total_deals,
      COUNT(*) FILTER (WHERE d.is_active = true AND NOT psc.is_terminal)::int AS active_deals,
      COUNT(*) FILTER (WHERE psc.slug = 'closed_won')::int AS won_deals,
      COUNT(*) FILTER (WHERE psc.slug = 'closed_lost')::int AS lost_deals,
      COALESCE(SUM(
        COALESCE(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0)
      ) FILTER (WHERE d.is_active = true AND NOT psc.is_terminal), 0)::numeric AS pipeline_value,
      COALESCE(SUM(
        COALESCE(d.awarded_amount, d.bid_estimate, 0)
      ) FILTER (WHERE psc.slug = 'closed_won'), 0)::numeric AS won_value
    FROM deals d
    JOIN pipeline_stage_config psc ON psc.id = d.stage_id
    WHERE d.created_at >= ${from}::timestamptz
      AND d.created_at <= (${to}::date + INTERVAL '1 day')::timestamptz
    GROUP BY COALESCE(d.source, 'Unknown')
    ORDER BY won_value DESC
  `);

  const rows = (result as any).rows ?? result;
  return rows.map((r: any) => {
    const won = Number(r.won_deals ?? 0);
    const lost = Number(r.lost_deals ?? 0);
    const closedTotal = won + lost;
    return {
      source: r.source,
      totalDeals: Number(r.total_deals ?? 0),
      activeDeals: Number(r.active_deals ?? 0),
      wonDeals: won,
      lostDeals: lost,
      pipelineValue: Number(r.pipeline_value ?? 0),
      wonValue: Number(r.won_value ?? 0),
      winRate: closedTotal > 0 ? Math.round((won / closedTotal) * 100) : 0,
    };
  });
}

// ---------------------------------------------------------------------------
// 10. Follow-up Compliance Rate
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
// 11. DD vs True Pipeline Value
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
// 12. Custom Report Query Executor
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
    "id", "type", "user_id", "deal_id", "contact_id",
    "subject", "outcome", "duration_minutes", "occurred_at", "created_at",
  ],
  tasks: [
    "id", "title", "type", "priority", "status", "assigned_to",
    "deal_id", "contact_id", "due_date", "completed_at",
    "is_overdue", "created_at", "updated_at",
  ],
};

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
    ? config.columns.filter((c) => allowed.includes(c))
    : allowed.slice(0, 10); // default to first 10 columns

  if (selectCols.length === 0) throw new Error("No valid columns selected");

  // Build WHERE clause from filters using parameter binding for all values.
  const whereClauses: ReturnType<typeof sql>[] = [];
  for (const filter of config.filters) {
    if (!allowed.includes(filter.field)) continue; // skip unknown fields

    const col = sql.identifier(filter.field);
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
  if (config.sort && allowed.includes(config.sort.field)) {
    const dir = config.sort.dir === "asc" ? sql`ASC` : sql`DESC`;
    orderClause = sql`ORDER BY ${sql.identifier(config.sort.field)} ${dir}`;
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
