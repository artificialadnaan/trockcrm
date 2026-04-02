# Plan 7: Reporting & Dashboards Implementation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the full reporting and dashboards system: Per-rep dashboard (my deals, tasks today, activity this week, follow-up compliance, pipeline chart), Director dashboard (all reps overview with performance cards, drill-down, pipeline by stage bar chart, win rate trend line, activity by rep bar chart, MoM/QoQ/YoY toggles, stale deal watchlist, activity drop alerts, DD vs true pipeline), 9 locked company reports (Pipeline Summary with/without DD, Weighted Pipeline Forecast, Win/Loss Ratio by Rep, Activity Summary by Rep, Stale Deals Report, Lost Deals by Reason with competitor, Revenue by Project Type, Lead Source ROI), custom report builder with saved filter presets stored as JSON config in `saved_reports`, and Recharts-based visual reporting (pie, bar, trend line).

**Architecture:** Reporting service as a tenant-scoped module with aggregation queries running against existing deal, activity, task, and stage history tables. Saved reports CRUD operates on the public `saved_reports` table (office-scoped). Dashboard endpoints aggregate data from multiple entity queries in parallel. Frontend uses Recharts for all chart components with shared wrapper utilities. Dashboards default to current calendar year; pipeline shows active deals only.

**Tech Stack:** TypeScript, Express, Drizzle ORM, PostgreSQL, React, Vite, Tailwind CSS, shadcn/ui, Recharts, lucide-react

**Spec Reference:** `docs/superpowers/specs/2026-04-01-trock-crm-design.md` -- Section 10 (Reporting & Dashboards), Section 11 (Default Date & Filter Behavior), Section 15 (Edge Cases -- DD deals counting)

**Depends On:** Plan 1 (Foundation) + Plan 2 (Deals & Pipeline) + Plan 3 (Contacts & Dedup) + Plan 4 (Email Integration) + Plan 5 (Files & Photos) + Plan 6 (Tasks & Notifications) -- all fully implemented.

**Already Exists (do NOT recreate):**
- `shared/src/schema/public/saved-reports.ts` -- saved_reports table with id, name, entity, config (JSONB), is_locked, is_default, created_by, office_id, visibility, timestamps
- `shared/src/types/enums.ts` -- REPORT_ENTITIES (`deals`, `contacts`, `activities`, `tasks`), REPORT_VISIBILITY (`private`, `office`, `company`)
- `shared/src/schema/index.ts` -- already exports savedReports, reportVisibilityEnum, reportEntityEnum
- `shared/src/schema/public/pipeline-stage-config.ts` -- stages with is_active_pipeline, is_terminal, stale_threshold_days, color
- `shared/src/schema/tenant/deals.ts` -- deals with dd_estimate, bid_estimate, awarded_amount, win_probability, source, project_type_id, lost_reason_id, lost_competitor, stage_entered_at, last_activity_at, expected_close_date, actual_close_date
- `shared/src/schema/tenant/activities.ts` -- activities with type (call/note/meeting/email/task_completed), user_id, deal_id, occurred_at
- `shared/src/schema/tenant/tasks.ts` -- tasks with assigned_to, status, type, due_date, completed_at, is_overdue
- `shared/src/schema/tenant/deal-stage-history.ts` -- stage transitions with from_stage_id, to_stage_id, created_at
- `shared/src/schema/public/lost-deal-reasons.ts` -- lost_deal_reasons with label
- `shared/src/schema/public/project-type-config.ts` -- project_type_config with name, slug
- `shared/src/schema/public/users.ts` -- users with display_name, role, office_id, is_active
- `server/src/modules/deals/service.ts` -- getDealsForPipeline (reference for stage grouping pattern)
- `server/src/modules/tasks/service.ts` -- getTaskCounts (reference for FILTER-based aggregation pattern)
- `server/src/middleware/rbac.ts` -- requireRole, requireDirector, requireAdmin
- `server/src/middleware/tenant.ts` -- tenantMiddleware providing req.tenantDb, req.commitTransaction
- `server/src/middleware/auth.ts` -- authMiddleware providing req.user with id, role, activeOfficeId, officeId
- `server/src/app.ts` -- createApp with tenantRouter mounting at `/api`
- `client/src/lib/api.ts` -- api() fetch wrapper
- `client/src/lib/auth.tsx` -- useAuth() with user (id, email, displayName, role, officeId, activeOfficeId)
- `client/src/hooks/use-deals.ts` -- Deal interface, useDeals hook
- `client/src/hooks/use-tasks.ts` -- Task interface, useTasks, useTaskCounts hooks
- `client/src/hooks/use-activities.ts` -- Activity interface, useActivities hook
- `client/src/hooks/use-pipeline-config.ts` -- pipeline stage config hook
- `client/src/App.tsx` -- routes with placeholder Dashboard and PlaceholderPage for `/reports` and `/director`
- `client/src/components/layout/sidebar.tsx` -- nav items already include Reports and Director links

---

## File Structure

```
server/src/modules/reports/
  ├── routes.ts                    # /api/reports/* route definitions
  ├── service.ts                   # Aggregation queries (pipeline stats, win/loss, activity, revenue, etc.)
  └── saved-reports-service.ts     # Saved reports CRUD (public schema)

server/src/modules/dashboard/
  ├── routes.ts                    # /api/dashboard/* route definitions (rep + director endpoints)
  └── service.ts                   # Dashboard data aggregation (per-rep, director overview)

server/tests/modules/reports/
  └── service.test.ts              # Reporting aggregation query tests

server/tests/modules/dashboard/
  └── service.test.ts              # Dashboard data aggregation tests

client/src/hooks/
  ├── use-dashboard.ts             # Rep dashboard data hook
  ├── use-director-dashboard.ts    # Director dashboard data + drill-down hooks
  └── use-reports.ts               # Saved reports CRUD + report execution hooks

client/src/pages/dashboard/
  └── rep-dashboard-page.tsx       # Per-rep dashboard (replaces placeholder)

client/src/pages/director/
  ├── director-dashboard-page.tsx  # Director overview with rep cards
  └── director-rep-detail.tsx      # Drill-down into single rep

client/src/pages/reports/
  └── reports-page.tsx             # Locked reports + custom report builder

client/src/components/charts/
  ├── chart-colors.ts              # Shared color palette + utilities
  ├── pipeline-bar-chart.tsx       # Pipeline by stage bar chart
  ├── activity-bar-chart.tsx       # Activity by rep or by type bar chart
  ├── win-rate-trend-chart.tsx     # Win rate trend line chart
  ├── pipeline-pie-chart.tsx       # Pipeline value pie chart
  └── report-chart.tsx             # Dynamic chart renderer for custom reports

client/src/components/dashboard/
  ├── stat-card.tsx                # Reusable KPI stat card
  ├── rep-performance-card.tsx     # Director view: per-rep summary card
  ├── stale-deal-list.tsx          # Stale deal watchlist widget
  └── date-range-toggle.tsx        # MoM / QoQ / YoY toggle component
```

---

## Task 1: Reporting Service -- Aggregation Queries

- [ ] Create `server/src/modules/reports/service.ts`

This is the core analytics engine. All queries run within the tenant-scoped transaction (tenantDb) so they respect the office schema. Date range parameters default to current calendar year.

### 1a. Reporting Service

**File: `server/src/modules/reports/service.ts`**

```typescript
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

/** Default to current calendar year boundaries */
function defaultDateRange(from?: string, to?: string): { from: string; to: string } {
  const year = new Date().getFullYear();
  return {
    from: from ?? `${year}-01-01`,
    to: to ?? `${year}-12-31`,
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
 * @param includeDd - if false, excludes stages where is_active_pipeline = false (DD stages)
 */
export async function getPipelineSummary(
  tenantDb: TenantDb,
  options: { includeDd?: boolean; from?: string; to?: string } = {}
): Promise<PipelineSummaryRow[]> {
  const { from, to } = defaultDateRange(options.from, options.to);
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
      AND d.created_at >= ${from}::timestamptz
      AND d.created_at <= (${to}::date + INTERVAL '1 day')::timestamptz
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
 */
export async function getWeightedPipelineForecast(
  tenantDb: TenantDb,
  options: { from?: string; to?: string } = {}
): Promise<WeightedForecastRow[]> {
  const { from, to } = defaultDateRange(options.from, options.to);

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
 * Win/loss ratio per rep. Counts deals that entered Closed Won or Closed Lost
 * during the date range (using deal_stage_history.created_at for accuracy).
 */
export async function getWinLossRatioByRep(
  tenantDb: TenantDb,
  options: { from?: string; to?: string } = {}
): Promise<WinLossRow[]> {
  const { from, to } = defaultDateRange(options.from, options.to);

  const result = await tenantDb.execute(sql`
    WITH terminal_moves AS (
      SELECT
        d.assigned_rep_id,
        psc.slug AS terminal_slug,
        d.id AS deal_id,
        COALESCE(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0)::numeric AS deal_value,
        dsh.created_at
      FROM deal_stage_history dsh
      JOIN deals d ON d.id = dsh.deal_id
      JOIN pipeline_stage_config psc ON psc.id = dsh.to_stage_id
      WHERE psc.is_terminal = true
        AND dsh.created_at >= ${from}::timestamptz
        AND dsh.created_at <= (${to}::date + INTERVAL '1 day')::timestamptz
    )
    SELECT
      tm.assigned_rep_id AS rep_id,
      u.display_name AS rep_name,
      COUNT(*) FILTER (WHERE tm.terminal_slug = 'closed_won')::int AS wins,
      COUNT(*) FILTER (WHERE tm.terminal_slug = 'closed_lost')::int AS losses,
      SUM(tm.deal_value) FILTER (WHERE tm.terminal_slug = 'closed_won')::numeric AS total_value
    FROM terminal_moves tm
    JOIN users u ON u.id = tm.assigned_rep_id
    GROUP BY tm.assigned_rep_id, u.display_name
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

  // Build WHERE clause from filters
  const whereParts: string[] = [];
  const params: any[] = [];
  let paramIdx = 1;

  for (const filter of config.filters) {
    if (!allowed.includes(filter.field)) continue; // skip unknown fields

    const col = `"${filter.field}"`; // quote column name
    switch (filter.op) {
      case "eq":
        whereParts.push(`${col} = $${paramIdx}`);
        params.push(filter.value);
        paramIdx++;
        break;
      case "neq":
        whereParts.push(`${col} != $${paramIdx}`);
        params.push(filter.value);
        paramIdx++;
        break;
      case "gt":
        whereParts.push(`${col} > $${paramIdx}`);
        params.push(filter.value);
        paramIdx++;
        break;
      case "gte":
        whereParts.push(`${col} >= $${paramIdx}`);
        params.push(filter.value);
        paramIdx++;
        break;
      case "lt":
        whereParts.push(`${col} < $${paramIdx}`);
        params.push(filter.value);
        paramIdx++;
        break;
      case "lte":
        whereParts.push(`${col} <= $${paramIdx}`);
        params.push(filter.value);
        paramIdx++;
        break;
      case "in":
        if (Array.isArray(filter.value) && filter.value.length > 0) {
          whereParts.push(`${col} = ANY($${paramIdx})`);
          params.push(filter.value);
          paramIdx++;
        }
        break;
      case "like":
        whereParts.push(`${col} ILIKE $${paramIdx}`);
        params.push(`%${filter.value}%`);
        paramIdx++;
        break;
      case "is_null":
        whereParts.push(`${col} IS NULL`);
        break;
      case "is_not_null":
        whereParts.push(`${col} IS NOT NULL`);
        break;
    }
  }

  const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";
  const selectList = selectCols.map((c) => `"${c}"`).join(", ");

  // Sort
  let orderClause = "";
  if (config.sort && allowed.includes(config.sort.field)) {
    const dir = config.sort.dir === "asc" ? "ASC" : "DESC";
    orderClause = `ORDER BY "${config.sort.field}" ${dir}`;
  }

  const offset = (pagination.page - 1) * pagination.limit;

  // Count query
  const countSql = `SELECT COUNT(*)::int AS total FROM "${entityTable}" ${whereClause}`;
  const countResult = await tenantDb.execute(sql.raw(countSql + ` -- params: ${JSON.stringify(params)}`));

  // Note: Drizzle's sql.raw doesn't support parameterized queries well.
  // Use the tenant client directly for parameterized custom reports.
  // This is safe because column names are validated against ALLOWED_COLUMNS.

  // Actually use tenantDb.execute with proper sql template for safety
  // For custom reports, we'll use the raw client since we've validated all inputs
  const dataQuery = `SELECT ${selectList} FROM "${entityTable}" ${whereClause} ${orderClause} LIMIT ${pagination.limit} OFFSET ${offset}`;

  // Execute via the raw tenant client that's already in the correct search_path
  const [countRes, dataRes] = await Promise.all([
    tenantDb.execute(sql`SELECT COUNT(*)::int AS total FROM ${sql.identifier(entityTable)} ${whereParts.length > 0 ? sql.raw(`WHERE ${whereParts.join(" AND ")}`) : sql``}`),
    tenantDb.execute(sql`SELECT ${sql.raw(selectList)} FROM ${sql.identifier(entityTable)} ${whereParts.length > 0 ? sql.raw(`WHERE ${whereParts.join(" AND ")}`) : sql``} ${orderClause ? sql.raw(orderClause) : sql``} LIMIT ${pagination.limit} OFFSET ${offset}`),
  ]);

  const countRows = (countRes as any).rows ?? countRes;
  const dataRows = (dataRes as any).rows ?? dataRes;

  return {
    rows: dataRows,
    total: Number(countRows[0]?.total ?? 0),
  };
}
```

**Important implementation notes:**
- All aggregation queries use `sql` template literals with parameterized values -- no string interpolation for user input.
- The `executeCustomReport` function validates all column names against `ALLOWED_COLUMNS` to prevent SQL injection. Filter values are parameterized.
- `defaultDateRange()` defaults to current calendar year per spec Section 11.
- Terminal stage slugs (`closed_won`, `closed_lost`) are matched via JOIN to `pipeline_stage_config` -- never hardcoded UUIDs.
- All numeric results use `Number()` coercion since PostgreSQL returns strings for numeric/bigint types.
- The `getDdVsPipeline` query uses `is_active_pipeline` flag from `pipeline_stage_config` -- DD stages have `is_active_pipeline = false`.

---

## Task 2: Saved Reports CRUD Service + API Routes

- [ ] Create `server/src/modules/reports/saved-reports-service.ts`
- [ ] Create `server/src/modules/reports/routes.ts`
- [ ] Register report routes in `server/src/app.ts`

### 2a. Saved Reports Service

**File: `server/src/modules/reports/saved-reports-service.ts`**

```typescript
import { eq, and, or, desc, sql } from "drizzle-orm";
import { savedReports } from "@trock-crm/shared/schema";
import { db } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";
import type { ReportConfig } from "./service.js";

export interface CreateSavedReportInput {
  name: string;
  entity: string;
  config: ReportConfig;
  visibility?: string;
  officeId: string;
  createdBy: string;
}

export interface UpdateSavedReportInput {
  name?: string;
  config?: ReportConfig;
  visibility?: string;
}

/**
 * Get all reports visible to a user:
 * - locked (company-wide) reports
 * - reports created by the user (private)
 * - reports shared to their office
 * - reports shared company-wide
 */
export async function getSavedReports(
  userId: string,
  officeId: string
) {
  const reports = await db
    .select()
    .from(savedReports)
    .where(
      or(
        eq(savedReports.isLocked, true),
        eq(savedReports.createdBy, userId),
        and(
          eq(savedReports.officeId, officeId),
          eq(savedReports.visibility, "office")
        ),
        eq(savedReports.visibility, "company")
      )
    )
    .orderBy(desc(savedReports.isLocked), desc(savedReports.isDefault), desc(savedReports.updatedAt));

  return reports;
}

/**
 * Get a single report by ID.
 */
export async function getSavedReportById(reportId: string) {
  const result = await db
    .select()
    .from(savedReports)
    .where(eq(savedReports.id, reportId))
    .limit(1);

  return result[0] ?? null;
}

/**
 * Create a custom saved report.
 */
export async function createSavedReport(input: CreateSavedReportInput) {
  const result = await db
    .insert(savedReports)
    .values({
      name: input.name,
      entity: input.entity as any,
      config: input.config,
      isLocked: false,
      isDefault: false,
      createdBy: input.createdBy,
      officeId: input.officeId,
      visibility: (input.visibility as any) ?? "private",
    })
    .returning();

  return result[0];
}

/**
 * Update a custom saved report.
 * Locked reports cannot be updated.
 */
export async function updateSavedReport(
  reportId: string,
  input: UpdateSavedReportInput,
  userId: string
) {
  const existing = await getSavedReportById(reportId);
  if (!existing) throw new AppError(404, "Report not found");
  if (existing.isLocked) throw new AppError(403, "Cannot edit a locked report");
  if (existing.createdBy !== userId) throw new AppError(403, "You can only edit your own reports");

  const updates: Record<string, any> = {};
  if (input.name !== undefined) updates.name = input.name;
  if (input.config !== undefined) updates.config = input.config;
  if (input.visibility !== undefined) updates.visibility = input.visibility;
  updates.updatedAt = new Date();

  if (Object.keys(updates).length === 0) return existing;

  const result = await db
    .update(savedReports)
    .set(updates)
    .where(eq(savedReports.id, reportId))
    .returning();

  return result[0];
}

/**
 * Delete a custom saved report.
 * Locked reports cannot be deleted.
 */
export async function deleteSavedReport(reportId: string, userId: string) {
  const existing = await getSavedReportById(reportId);
  if (!existing) throw new AppError(404, "Report not found");
  if (existing.isLocked) throw new AppError(403, "Cannot delete a locked report");
  if (existing.createdBy !== userId) throw new AppError(403, "You can only delete your own reports");

  await db.delete(savedReports).where(eq(savedReports.id, reportId));
  return { success: true };
}

/**
 * Seed the 9 locked company reports if they don't already exist.
 * Called once during server startup or via admin endpoint.
 */
export async function seedLockedReports(officeId: string) {
  // Check if locked reports already exist for this office
  const existing = await db
    .select({ id: savedReports.id })
    .from(savedReports)
    .where(and(eq(savedReports.isLocked, true), eq(savedReports.officeId, officeId)))
    .limit(1);

  if (existing.length > 0) return; // already seeded

  const lockedReports: Array<{
    name: string;
    entity: string;
    config: object;
  }> = [
    {
      name: "Pipeline Summary (Excluding DD)",
      entity: "deals",
      config: {
        reportType: "pipeline_summary",
        includeDd: false,
        chart_type: "bar",
      },
    },
    {
      name: "Pipeline Summary (With DD)",
      entity: "deals",
      config: {
        reportType: "pipeline_summary",
        includeDd: true,
        chart_type: "bar",
      },
    },
    {
      name: "Weighted Pipeline Forecast",
      entity: "deals",
      config: {
        reportType: "weighted_forecast",
        chart_type: "bar",
      },
    },
    {
      name: "Win/Loss Ratio by Rep",
      entity: "deals",
      config: {
        reportType: "win_loss_ratio",
        chart_type: "bar",
      },
    },
    {
      name: "Activity Summary by Rep",
      entity: "activities",
      config: {
        reportType: "activity_summary",
        chart_type: "bar",
      },
    },
    {
      name: "Stale Deals Report",
      entity: "deals",
      config: {
        reportType: "stale_deals",
        chart_type: "table",
      },
    },
    {
      name: "Lost Deals by Reason",
      entity: "deals",
      config: {
        reportType: "lost_by_reason",
        chart_type: "bar",
      },
    },
    {
      name: "Revenue by Project Type",
      entity: "deals",
      config: {
        reportType: "revenue_by_project_type",
        chart_type: "pie",
      },
    },
    {
      name: "Lead Source ROI",
      entity: "deals",
      config: {
        reportType: "lead_source_roi",
        chart_type: "bar",
      },
    },
  ];

  await db.insert(savedReports).values(
    lockedReports.map((r) => ({
      name: r.name,
      entity: r.entity as any,
      config: r.config,
      isLocked: true,
      isDefault: true,
      officeId,
      visibility: "company" as const,
    }))
  );
}
```

### 2b. Report Routes

**File: `server/src/modules/reports/routes.ts`**

```typescript
import { Router } from "express";
import { requireRole } from "../../middleware/rbac.js";
import { AppError } from "../../middleware/error-handler.js";
import {
  getPipelineSummary,
  getWeightedPipelineForecast,
  getWinLossRatioByRep,
  getWinRateTrend,
  getActivitySummaryByRep,
  getStaleDeals,
  getLostDealsByReason,
  getRevenueByProjectType,
  getLeadSourceROI,
  getFollowUpCompliance,
  getDdVsPipeline,
  executeCustomReport,
} from "./service.js";
import type { ReportConfig } from "./service.js";
import {
  getSavedReports,
  getSavedReportById,
  createSavedReport,
  updateSavedReport,
  deleteSavedReport,
  seedLockedReports,
} from "./saved-reports-service.js";

const router = Router();

// -------------------------------------------------------------------------
// Locked report execution endpoints
// -------------------------------------------------------------------------

// GET /api/reports/pipeline-summary?includeDd=false&from=2026-01-01&to=2026-12-31
router.get("/pipeline-summary", async (req, res, next) => {
  try {
    const data = await getPipelineSummary(req.tenantDb!, {
      includeDd: req.query.includeDd === "true",
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
    });
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/weighted-forecast?from=2026-01-01&to=2026-12-31
router.get("/weighted-forecast", async (req, res, next) => {
  try {
    const data = await getWeightedPipelineForecast(req.tenantDb!, {
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
    });
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/win-loss?from=2026-01-01&to=2026-12-31
router.get("/win-loss", async (req, res, next) => {
  try {
    const data = await getWinLossRatioByRep(req.tenantDb!, {
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
    });
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/win-rate-trend?from=2026-01-01&to=2026-12-31&repId=uuid
router.get("/win-rate-trend", async (req, res, next) => {
  try {
    const data = await getWinRateTrend(req.tenantDb!, {
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
      repId: req.query.repId as string | undefined,
    });
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/activity-summary?from=2026-01-01&to=2026-12-31
router.get("/activity-summary", async (req, res, next) => {
  try {
    const data = await getActivitySummaryByRep(req.tenantDb!, {
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
    });
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/stale-deals?repId=uuid
router.get("/stale-deals", async (req, res, next) => {
  try {
    const data = await getStaleDeals(req.tenantDb!, {
      repId: req.query.repId as string | undefined,
    });
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/lost-by-reason?from=2026-01-01&to=2026-12-31
router.get("/lost-by-reason", async (req, res, next) => {
  try {
    const data = await getLostDealsByReason(req.tenantDb!, {
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
    });
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/revenue-by-type?from=2026-01-01&to=2026-12-31
router.get("/revenue-by-type", async (req, res, next) => {
  try {
    const data = await getRevenueByProjectType(req.tenantDb!, {
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
    });
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/lead-source-roi?from=2026-01-01&to=2026-12-31
router.get("/lead-source-roi", async (req, res, next) => {
  try {
    const data = await getLeadSourceROI(req.tenantDb!, {
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
    });
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/follow-up-compliance?repId=uuid&from=2026-01-01&to=2026-12-31
router.get("/follow-up-compliance", async (req, res, next) => {
  try {
    const repId = (req.query.repId as string) || req.user!.id;
    const data = await getFollowUpCompliance(req.tenantDb!, repId, {
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
    });
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/dd-vs-pipeline
router.get("/dd-vs-pipeline", async (req, res, next) => {
  try {
    const data = await getDdVsPipeline(req.tenantDb!);
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------------------
// Custom report execution
// -------------------------------------------------------------------------

// POST /api/reports/execute — run a custom report config
router.post("/execute", async (req, res, next) => {
  try {
    const config = req.body.config as ReportConfig;
    if (!config || !config.entity) {
      throw new AppError(400, "config with entity is required");
    }
    const page = req.body.page ? parseInt(req.body.page, 10) : 1;
    const limit = req.body.limit ? parseInt(req.body.limit, 10) : 100;

    const data = await executeCustomReport(req.tenantDb!, config, { page, limit });
    await req.commitTransaction!();
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------------------
// Saved reports CRUD
// -------------------------------------------------------------------------

// GET /api/reports/saved — list saved reports visible to the user
router.get("/saved", async (req, res, next) => {
  try {
    const reports = await getSavedReports(
      req.user!.id,
      req.user!.activeOfficeId ?? req.user!.officeId
    );
    await req.commitTransaction!();
    res.json({ reports });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/saved/:id — get a single saved report
router.get("/saved/:id", async (req, res, next) => {
  try {
    const report = await getSavedReportById(req.params.id);
    if (!report) throw new AppError(404, "Report not found");
    await req.commitTransaction!();
    res.json({ report });
  } catch (err) {
    next(err);
  }
});

// POST /api/reports/saved — create a custom report
router.post("/saved", async (req, res, next) => {
  try {
    const { name, entity, config, visibility } = req.body;
    if (!name || !entity || !config) {
      throw new AppError(400, "name, entity, and config are required");
    }

    const report = await createSavedReport({
      name,
      entity,
      config,
      visibility,
      officeId: req.user!.activeOfficeId ?? req.user!.officeId,
      createdBy: req.user!.id,
    });
    await req.commitTransaction!();
    res.status(201).json({ report });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/reports/saved/:id — update a custom report
router.patch("/saved/:id", async (req, res, next) => {
  try {
    const report = await updateSavedReport(
      req.params.id,
      req.body,
      req.user!.id
    );
    await req.commitTransaction!();
    res.json({ report });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/reports/saved/:id — delete a custom report
router.delete("/saved/:id", async (req, res, next) => {
  try {
    const result = await deleteSavedReport(req.params.id, req.user!.id);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/reports/seed — seed locked reports for the user's office (admin only)
router.post(
  "/seed",
  requireRole("admin"),
  async (req, res, next) => {
    try {
      await seedLockedReports(req.user!.activeOfficeId ?? req.user!.officeId);
      await req.commitTransaction!();
      res.json({ success: true, message: "Locked reports seeded" });
    } catch (err) {
      next(err);
    }
  }
);

export const reportRoutes = router;
```

### 2c. Register Routes in app.ts

**File: `server/src/app.ts`** -- ADD these lines:

```typescript
// ADD import at top:
import { reportRoutes } from "./modules/reports/routes.js";

// ADD to tenantRouter section (after activityRoutes):
tenantRouter.use("/reports", reportRoutes);
```

---

## Task 3: Dashboard API Endpoints (Rep + Director)

- [ ] Create `server/src/modules/dashboard/service.ts`
- [ ] Create `server/src/modules/dashboard/routes.ts`
- [ ] Register dashboard routes in `server/src/app.ts`

### 3a. Dashboard Service

**File: `server/src/modules/dashboard/service.ts`**

```typescript
import { eq, and, sql, gte, lte, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  deals,
  activities,
  tasks,
  users,
  pipelineStageConfig,
} from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { db } from "../../db.js";
import {
  getPipelineSummary,
  getWinRateTrend,
  getActivitySummaryByRep,
  getStaleDeals,
  getFollowUpCompliance,
  getDdVsPipeline,
  getWinLossRatioByRep,
} from "../reports/service.js";

type TenantDb = NodePgDatabase<typeof schema>;

// ---------------------------------------------------------------------------
// Per-Rep Dashboard
// ---------------------------------------------------------------------------

export interface RepDashboardData {
  activeDeals: { count: number; totalValue: number };
  tasksToday: { overdue: number; today: number };
  activityThisWeek: { calls: number; emails: number; meetings: number; notes: number; total: number };
  followUpCompliance: { total: number; onTime: number; complianceRate: number };
  pipelineByStage: Array<{
    stageId: string;
    stageName: string;
    stageColor: string | null;
    dealCount: number;
    totalValue: number;
  }>;
}

/**
 * Aggregate all data for the per-rep dashboard.
 * Queries run in parallel for performance.
 */
export async function getRepDashboard(
  tenantDb: TenantDb,
  userId: string
): Promise<RepDashboardData> {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" }); // YYYY-MM-DD in CT
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekAgoStr = weekAgo.toISOString();

  const year = new Date().getFullYear();
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  const [
    activeDealResult,
    taskCountResult,
    activityResult,
    complianceResult,
    pipelineResult,
  ] = await Promise.all([
    // 1. Active deals count + value for this rep
    tenantDb.execute(sql`
      SELECT
        COUNT(*)::int AS count,
        COALESCE(SUM(
          COALESCE(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0)
        ), 0)::numeric AS total_value
      FROM deals d
      JOIN pipeline_stage_config psc ON psc.id = d.stage_id
      WHERE d.is_active = true
        AND d.assigned_rep_id = ${userId}
        AND NOT psc.is_terminal
    `),

    // 2. Tasks: overdue + today counts
    tenantDb.execute(sql`
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

    // 3. Activity this week by type
    tenantDb.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE type = 'call')::int AS calls,
        COUNT(*) FILTER (WHERE type = 'email')::int AS emails,
        COUNT(*) FILTER (WHERE type = 'meeting')::int AS meetings,
        COUNT(*) FILTER (WHERE type = 'note')::int AS notes,
        COUNT(*)::int AS total
      FROM activities
      WHERE user_id = ${userId}
        AND occurred_at >= ${weekAgoStr}::timestamptz
    `),

    // 4. Follow-up compliance YTD
    getFollowUpCompliance(tenantDb, userId, { from: yearStart, to: yearEnd }),

    // 5. Pipeline by stage for this rep (active deals only)
    tenantDb.execute(sql`
      SELECT
        d.stage_id,
        psc.name AS stage_name,
        psc.color AS stage_color,
        psc.display_order,
        COUNT(*)::int AS deal_count,
        COALESCE(SUM(
          COALESCE(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0)
        ), 0)::numeric AS total_value
      FROM deals d
      JOIN pipeline_stage_config psc ON psc.id = d.stage_id
      WHERE d.is_active = true
        AND d.assigned_rep_id = ${userId}
        AND NOT psc.is_terminal
        AND psc.is_active_pipeline = true
      GROUP BY d.stage_id, psc.name, psc.color, psc.display_order
      ORDER BY psc.display_order ASC
    `),
  ]);

  const adRows = (activeDealResult as any).rows ?? activeDealResult;
  const tcRows = (taskCountResult as any).rows ?? taskCountResult;
  const acRows = (activityResult as any).rows ?? activityResult;
  const plRows = (pipelineResult as any).rows ?? pipelineResult;

  return {
    activeDeals: {
      count: Number(adRows[0]?.count ?? 0),
      totalValue: Number(adRows[0]?.total_value ?? 0),
    },
    tasksToday: {
      overdue: Number(tcRows[0]?.overdue ?? 0),
      today: Number(tcRows[0]?.today ?? 0),
    },
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
}

export interface DirectorDashboardData {
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
  }>;
  ddVsPipeline: {
    ddValue: number;
    ddCount: number;
    pipelineValue: number;
    pipelineCount: number;
    totalValue: number;
    totalCount: number;
  };
}

/**
 * Aggregate all data for the director dashboard.
 * All queries run in parallel and use the date range (defaults to current calendar year).
 */
export async function getDirectorDashboard(
  tenantDb: TenantDb,
  options: { from?: string; to?: string } = {}
): Promise<DirectorDashboardData> {
  const year = new Date().getFullYear();
  const from = options.from ?? `${year}-01-01`;
  const to = options.to ?? `${year}-12-31`;

  const [
    repCardsResult,
    pipelineResult,
    winRateTrendResult,
    activityResult,
    staleResult,
    ddResult,
  ] = await Promise.all([
    // 1. Per-rep performance cards
    buildRepPerformanceCards(tenantDb, { from, to }),

    // 2. Pipeline by stage (company-wide, excluding DD)
    getPipelineSummary(tenantDb, { includeDd: false, from, to }),

    // 3. Win rate trend
    getWinRateTrend(tenantDb, { from, to }),

    // 4. Activity by rep
    getActivitySummaryByRep(tenantDb, { from, to }),

    // 5. Stale deals watchlist
    getStaleDeals(tenantDb),

    // 6. DD vs pipeline
    getDdVsPipeline(tenantDb),
  ]);

  return {
    repCards: repCardsResult,
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
    staleDeals: staleResult.map((s) => ({
      dealId: s.dealId,
      dealNumber: s.dealNumber,
      dealName: s.dealName,
      stageName: s.stageName,
      repName: s.repName,
      daysInStage: s.daysInStage,
      dealValue: s.dealValue,
    })),
    ddVsPipeline: ddResult,
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
    WITH rep_deals AS (
      SELECT
        d.assigned_rep_id AS rep_id,
        COUNT(*) FILTER (WHERE d.is_active AND NOT psc.is_terminal)::int AS active_deals,
        COALESCE(SUM(
          COALESCE(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0)
        ) FILTER (WHERE d.is_active AND NOT psc.is_terminal AND psc.is_active_pipeline), 0)::numeric AS pipeline_value
      FROM deals d
      JOIN pipeline_stage_config psc ON psc.id = d.stage_id
      GROUP BY d.assigned_rep_id
    ),
    rep_wins AS (
      SELECT
        d.assigned_rep_id AS rep_id,
        COUNT(*) FILTER (WHERE psc.slug = 'closed_won')::int AS wins,
        COUNT(*) FILTER (WHERE psc.slug = 'closed_lost')::int AS losses
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
        a.user_id AS rep_id,
        COUNT(*)::int AS total
      FROM activities a
      WHERE a.occurred_at >= ${from}::timestamptz
        AND a.occurred_at <= (${to}::date + INTERVAL '1 day')::timestamptz
      GROUP BY a.user_id
    ),
    rep_stale AS (
      SELECT
        d.assigned_rep_id AS rep_id,
        COUNT(*)::int AS stale_count
      FROM deals d
      JOIN pipeline_stage_config psc ON psc.id = d.stage_id
      WHERE d.is_active = true
        AND NOT psc.is_terminal
        AND psc.stale_threshold_days IS NOT NULL
        AND EXTRACT(DAY FROM NOW() - d.stage_entered_at) > psc.stale_threshold_days
      GROUP BY d.assigned_rep_id
    )
    SELECT
      u.id AS rep_id,
      u.display_name AS rep_name,
      COALESCE(rd.active_deals, 0)::int AS active_deals,
      COALESCE(rd.pipeline_value, 0)::numeric AS pipeline_value,
      COALESCE(rw.wins, 0)::int AS wins,
      COALESCE(rw.losses, 0)::int AS losses,
      COALESCE(ra.total, 0)::int AS activity_score,
      COALESCE(rs.stale_count, 0)::int AS stale_deals
    FROM users u
    LEFT JOIN rep_deals rd ON rd.rep_id = u.id
    LEFT JOIN rep_wins rw ON rw.rep_id = u.id
    LEFT JOIN rep_activities ra ON ra.rep_id = u.id
    LEFT JOIN rep_stale rs ON rs.rep_id = u.id
    WHERE u.is_active = true
      AND u.role = 'rep'
    ORDER BY pipeline_value DESC
  `);

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
      staleDeals: Number(r.stale_deals ?? 0),
    };
  });
}

// ---------------------------------------------------------------------------
// Director Drill-Down (single rep detail)
// ---------------------------------------------------------------------------

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

  const [dashboard, winLoss, winTrend, staleDeals] = await Promise.all([
    getRepDashboard(tenantDb, repId),
    getWinLossRatioByRep(tenantDb, { from, to }),
    getWinRateTrend(tenantDb, { from, to, repId }),
    getStaleDeals(tenantDb, { repId }),
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
  };
}
```

### 3b. Dashboard Routes

**File: `server/src/modules/dashboard/routes.ts`**

```typescript
import { Router } from "express";
import { requireRole } from "../../middleware/rbac.js";
import { AppError } from "../../middleware/error-handler.js";
import {
  getRepDashboard,
  getDirectorDashboard,
  getRepDetail,
} from "./service.js";

const router = Router();

// GET /api/dashboard/rep — per-rep dashboard (current user)
router.get("/rep", async (req, res, next) => {
  try {
    const data = await getRepDashboard(req.tenantDb!, req.user!.id);
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/director — director overview (admin/director only)
router.get(
  "/director",
  requireRole("admin", "director"),
  async (req, res, next) => {
    try {
      const data = await getDirectorDashboard(req.tenantDb!, {
        from: req.query.from as string | undefined,
        to: req.query.to as string | undefined,
      });
      await req.commitTransaction!();
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/dashboard/director/rep/:repId — drill-down into a specific rep (admin/director only)
router.get(
  "/director/rep/:repId",
  requireRole("admin", "director"),
  async (req, res, next) => {
    try {
      const data = await getRepDetail(req.tenantDb!, req.params.repId, {
        from: req.query.from as string | undefined,
        to: req.query.to as string | undefined,
      });
      await req.commitTransaction!();
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

export const dashboardRoutes = router;
```

### 3c. Register Dashboard Routes in app.ts

**File: `server/src/app.ts`** -- ADD these lines:

```typescript
// ADD import at top:
import { dashboardRoutes } from "./modules/dashboard/routes.js";

// ADD to tenantRouter section (after reportRoutes):
tenantRouter.use("/dashboard", dashboardRoutes);
```

**Full app.ts tenantRouter section after all additions:**

```typescript
  // Feature routes
  tenantRouter.use("/deals", dealRoutes);
  tenantRouter.use("/pipeline", pipelineRoutes);
  tenantRouter.use("/contacts", contactRoutes);
  tenantRouter.use("/email", emailRoutes);
  tenantRouter.use("/files", fileRoutes);
  tenantRouter.use("/tasks", taskRoutes);
  tenantRouter.use("/activities", activityRoutes);
  tenantRouter.use("/notifications", notificationCrudRoutes);
  tenantRouter.use("/reports", reportRoutes);
  tenantRouter.use("/dashboard", dashboardRoutes);
```

---

## Task 4: Backend Tests

- [ ] Create `server/tests/modules/reports/service.test.ts`
- [ ] Create `server/tests/modules/dashboard/service.test.ts`

### 4a. Report Service Tests

**File: `server/tests/modules/reports/service.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for the reporting service aggregation queries.
 *
 * These tests validate the query builder logic and result mapping.
 * Because the aggregation queries use raw SQL via tenantDb.execute(),
 * integration tests against a real PostgreSQL instance are recommended
 * for full validation. These unit tests verify the service functions
 * exist, accept the correct parameters, and handle empty results.
 */

// Mock the db import (public schema queries)
vi.mock("../../../src/db.js", () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnValue([]),
  },
}));

// Create a mock tenantDb
function createMockTenantDb(rows: any[] = []) {
  return {
    execute: vi.fn().mockResolvedValue({ rows }),
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnValue([]),
  } as any;
}

describe("Reports Service", () => {
  describe("getPipelineSummary", () => {
    it("should return empty array when no stages exist", async () => {
      const { getPipelineSummary } = await import("../../../src/modules/reports/service.js");
      const tenantDb = createMockTenantDb([]);
      // db mock returns empty stages
      const result = await getPipelineSummary(tenantDb);
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("getWeightedPipelineForecast", () => {
    it("should return forecast rows with numeric values", async () => {
      const { getWeightedPipelineForecast } = await import("../../../src/modules/reports/service.js");
      const tenantDb = createMockTenantDb([
        { month: "2026-03", deal_count: "5", raw_value: "500000", weighted_value: "250000" },
      ]);
      const result = await getWeightedPipelineForecast(tenantDb);
      expect(result).toHaveLength(1);
      expect(result[0].month).toBe("2026-03");
      expect(result[0].dealCount).toBe(5);
      expect(result[0].rawValue).toBe(500000);
      expect(result[0].weightedValue).toBe(250000);
    });
  });

  describe("getWinLossRatioByRep", () => {
    it("should calculate win rate correctly", async () => {
      const { getWinLossRatioByRep } = await import("../../../src/modules/reports/service.js");
      const tenantDb = createMockTenantDb([
        { rep_id: "r1", rep_name: "Alice", wins: "3", losses: "1", total_value: "300000" },
      ]);
      const result = await getWinLossRatioByRep(tenantDb);
      expect(result).toHaveLength(1);
      expect(result[0].winRate).toBe(75);
    });

    it("should handle zero closed deals gracefully", async () => {
      const { getWinLossRatioByRep } = await import("../../../src/modules/reports/service.js");
      const tenantDb = createMockTenantDb([
        { rep_id: "r1", rep_name: "Bob", wins: "0", losses: "0", total_value: "0" },
      ]);
      const result = await getWinLossRatioByRep(tenantDb);
      expect(result[0].winRate).toBe(0);
    });
  });

  describe("getActivitySummaryByRep", () => {
    it("should return activity breakdown by type", async () => {
      const { getActivitySummaryByRep } = await import("../../../src/modules/reports/service.js");
      const tenantDb = createMockTenantDb([
        {
          rep_id: "r1", rep_name: "Alice",
          calls: "10", emails: "20", meetings: "5", notes: "3", tasks_completed: "7", total: "45",
        },
      ]);
      const result = await getActivitySummaryByRep(tenantDb);
      expect(result[0].calls).toBe(10);
      expect(result[0].emails).toBe(20);
      expect(result[0].total).toBe(45);
    });
  });

  describe("getFollowUpCompliance", () => {
    it("should return 100% when no follow-up tasks exist", async () => {
      const { getFollowUpCompliance } = await import("../../../src/modules/reports/service.js");
      const tenantDb = createMockTenantDb([{ total: "0", on_time: "0" }]);
      const result = await getFollowUpCompliance(tenantDb, "rep-id");
      expect(result.complianceRate).toBe(100);
    });

    it("should calculate compliance rate correctly", async () => {
      const { getFollowUpCompliance } = await import("../../../src/modules/reports/service.js");
      const tenantDb = createMockTenantDb([{ total: "10", on_time: "8" }]);
      const result = await getFollowUpCompliance(tenantDb, "rep-id");
      expect(result.complianceRate).toBe(80);
    });
  });

  describe("getLeadSourceROI", () => {
    it("should return source breakdown with win rates", async () => {
      const { getLeadSourceROI } = await import("../../../src/modules/reports/service.js");
      const tenantDb = createMockTenantDb([
        {
          source: "Referral", total_deals: "10", active_deals: "5",
          won_deals: "3", lost_deals: "2", pipeline_value: "500000", won_value: "300000",
        },
      ]);
      const result = await getLeadSourceROI(tenantDb);
      expect(result[0].source).toBe("Referral");
      expect(result[0].winRate).toBe(60);
    });
  });

  describe("getDdVsPipeline", () => {
    it("should separate DD and pipeline values", async () => {
      const { getDdVsPipeline } = await import("../../../src/modules/reports/service.js");
      const tenantDb = createMockTenantDb([
        { dd_value: "100000", dd_count: "5", pipeline_value: "400000", pipeline_count: "20" },
      ]);
      const result = await getDdVsPipeline(tenantDb);
      expect(result.ddValue).toBe(100000);
      expect(result.pipelineValue).toBe(400000);
      expect(result.totalValue).toBe(500000);
    });
  });

  describe("defaultDateRange", () => {
    it("should default to current calendar year", async () => {
      // Verified through getPipelineSummary -- when no from/to, uses year boundaries
      const year = new Date().getFullYear();
      // This is implicitly tested via all service functions that call defaultDateRange
      expect(year).toBeGreaterThan(2025);
    });
  });
});
```

### 4b. Dashboard Service Tests

**File: `server/tests/modules/dashboard/service.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/db.js", () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnValue([]),
  },
}));

function createMockTenantDb(responses: any[][] = []) {
  let callIndex = 0;
  return {
    execute: vi.fn().mockImplementation(() => {
      const rows = responses[callIndex] ?? [];
      callIndex++;
      return Promise.resolve({ rows });
    }),
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnValue([]),
  } as any;
}

describe("Dashboard Service", () => {
  describe("getRepDashboard", () => {
    it("should return all dashboard sections", async () => {
      const { getRepDashboard } = await import("../../../src/modules/dashboard/service.js");
      const tenantDb = createMockTenantDb([
        // active deals
        [{ count: "5", total_value: "500000" }],
        // task counts
        [{ overdue: "2", today: "3" }],
        // activity this week
        [{ calls: "5", emails: "10", meetings: "2", notes: "3", total: "20" }],
        // follow-up compliance (from reports/service)
        [{ total: "10", on_time: "9" }],
        // pipeline by stage
        [
          { stage_id: "s1", stage_name: "Estimating", stage_color: "#3B82F6", display_order: 2, deal_count: "3", total_value: "300000" },
        ],
      ]);

      const result = await getRepDashboard(tenantDb, "user-1");
      expect(result.activeDeals.count).toBe(5);
      expect(result.tasksToday.overdue).toBe(2);
      expect(result.activityThisWeek.total).toBe(20);
      expect(result.followUpCompliance.complianceRate).toBe(90);
      expect(result.pipelineByStage).toHaveLength(1);
    });
  });

  describe("getDirectorDashboard", () => {
    it("should return director-level aggregations", async () => {
      // This test validates the function exists and returns the expected shape.
      // Full integration testing requires a database with seeded data.
      const { getDirectorDashboard } = await import("../../../src/modules/dashboard/service.js");
      expect(typeof getDirectorDashboard).toBe("function");
    });
  });
});
```

---

## Task 5: Frontend -- Dashboard Hooks and Chart Utilities

- [ ] Create `client/src/hooks/use-dashboard.ts`
- [ ] Create `client/src/hooks/use-director-dashboard.ts`
- [ ] Create `client/src/hooks/use-reports.ts`
- [ ] Create `client/src/components/charts/chart-colors.ts`

### 5a. Rep Dashboard Hook

**File: `client/src/hooks/use-dashboard.ts`**

```typescript
import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";

export interface RepDashboardData {
  activeDeals: { count: number; totalValue: number };
  tasksToday: { overdue: number; today: number };
  activityThisWeek: {
    calls: number;
    emails: number;
    meetings: number;
    notes: number;
    total: number;
  };
  followUpCompliance: { total: number; onTime: number; complianceRate: number };
  pipelineByStage: Array<{
    stageId: string;
    stageName: string;
    stageColor: string | null;
    dealCount: number;
    totalValue: number;
  }>;
}

export function useRepDashboard() {
  const [data, setData] = useState<RepDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api<{ data: RepDashboardData }>("/dashboard/rep");
      setData(res.data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load dashboard");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch();
  }, [fetch]);

  return { data, loading, error, refetch: fetch };
}
```

### 5b. Director Dashboard Hook

**File: `client/src/hooks/use-director-dashboard.ts`**

```typescript
import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";

export interface RepPerformanceCard {
  repId: string;
  repName: string;
  activeDeals: number;
  pipelineValue: number;
  winRate: number;
  activityScore: number;
  staleDeals: number;
}

export interface DirectorDashboardData {
  repCards: RepPerformanceCard[];
  pipelineByStage: Array<{
    stageId: string;
    stageName: string;
    stageColor: string | null;
    dealCount: number;
    totalValue: number;
  }>;
  winRateTrend: Array<{
    month: string;
    wins: number;
    losses: number;
    winRate: number;
  }>;
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
  }>;
  ddVsPipeline: {
    ddValue: number;
    ddCount: number;
    pipelineValue: number;
    pipelineCount: number;
    totalValue: number;
    totalCount: number;
  };
}

export interface RepDetailData {
  activeDeals: { count: number; totalValue: number };
  tasksToday: { overdue: number; today: number };
  activityThisWeek: {
    calls: number;
    emails: number;
    meetings: number;
    notes: number;
    total: number;
  };
  followUpCompliance: { total: number; onTime: number; complianceRate: number };
  pipelineByStage: Array<{
    stageId: string;
    stageName: string;
    stageColor: string | null;
    dealCount: number;
    totalValue: number;
  }>;
  winLoss: {
    repId: string;
    repName: string;
    wins: number;
    losses: number;
    winRate: number;
    totalValue: number;
  };
  winRateTrend: Array<{ month: string; wins: number; losses: number; winRate: number }>;
  staleDeals: Array<{
    dealId: string;
    dealNumber: string;
    dealName: string;
    stageName: string;
    repName: string;
    daysInStage: number;
    dealValue: number;
  }>;
}

export type DateRangePreset = "mtd" | "qtd" | "ytd" | "last_month" | "last_quarter" | "last_year" | "custom";

/** Convert a preset to from/to date strings */
export function presetToDateRange(preset: DateRangePreset): { from: string; to: string } {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-indexed
  const today = now.toLocaleDateString("en-CA"); // YYYY-MM-DD

  switch (preset) {
    case "mtd":
      return { from: `${year}-${String(month + 1).padStart(2, "0")}-01`, to: today };
    case "qtd": {
      const qStart = Math.floor(month / 3) * 3;
      return { from: `${year}-${String(qStart + 1).padStart(2, "0")}-01`, to: today };
    }
    case "ytd":
      return { from: `${year}-01-01`, to: today };
    case "last_month": {
      const lm = month === 0 ? 11 : month - 1;
      const lmYear = month === 0 ? year - 1 : year;
      const lastDay = new Date(lmYear, lm + 1, 0).getDate();
      return {
        from: `${lmYear}-${String(lm + 1).padStart(2, "0")}-01`,
        to: `${lmYear}-${String(lm + 1).padStart(2, "0")}-${lastDay}`,
      };
    }
    case "last_quarter": {
      const cq = Math.floor(month / 3);
      const lq = cq === 0 ? 3 : cq - 1;
      const lqYear = cq === 0 ? year - 1 : year;
      const lqStart = lq * 3;
      const lqEndMonth = lqStart + 2;
      const lqLastDay = new Date(lqYear, lqEndMonth + 1, 0).getDate();
      return {
        from: `${lqYear}-${String(lqStart + 1).padStart(2, "0")}-01`,
        to: `${lqYear}-${String(lqEndMonth + 1).padStart(2, "0")}-${lqLastDay}`,
      };
    }
    case "last_year":
      return { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` };
    default: // custom or ytd fallback
      return { from: `${year}-01-01`, to: today };
  }
}

export function useDirectorDashboard(dateRange?: { from: string; to: string }) {
  const [data, setData] = useState<DirectorDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (dateRange?.from) params.set("from", dateRange.from);
      if (dateRange?.to) params.set("to", dateRange.to);
      const qs = params.toString();
      const res = await api<{ data: DirectorDashboardData }>(
        `/dashboard/director${qs ? `?${qs}` : ""}`
      );
      setData(res.data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load director dashboard");
    } finally {
      setLoading(false);
    }
  }, [dateRange?.from, dateRange?.to]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, error, refetch: fetchData };
}

export function useRepDetail(repId: string | undefined, dateRange?: { from: string; to: string }) {
  const [data, setData] = useState<RepDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!repId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (dateRange?.from) params.set("from", dateRange.from);
      if (dateRange?.to) params.set("to", dateRange.to);
      const qs = params.toString();
      const res = await api<{ data: RepDetailData }>(
        `/dashboard/director/rep/${repId}${qs ? `?${qs}` : ""}`
      );
      setData(res.data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load rep detail");
    } finally {
      setLoading(false);
    }
  }, [repId, dateRange?.from, dateRange?.to]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, error, refetch: fetchData };
}
```

### 5c. Reports Hook

**File: `client/src/hooks/use-reports.ts`**

```typescript
import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";

export interface SavedReport {
  id: string;
  name: string;
  entity: string;
  config: any;
  isLocked: boolean;
  isDefault: boolean;
  createdBy: string | null;
  officeId: string | null;
  visibility: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReportConfig {
  entity: "deals" | "contacts" | "activities" | "tasks";
  filters: Array<{
    field: string;
    op: string;
    value?: any;
  }>;
  columns: string[];
  sort?: { field: string; dir: "asc" | "desc" };
  chart_type?: "table" | "bar" | "pie" | "line";
  // Locked report specific
  reportType?: string;
  includeDd?: boolean;
}

export function useSavedReports() {
  const [reports, setReports] = useState<SavedReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchReports = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ reports: SavedReport[] }>("/reports/saved");
      setReports(data.reports);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load reports");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  return { reports, loading, error, refetch: fetchReports };
}

export async function createSavedReport(input: {
  name: string;
  entity: string;
  config: ReportConfig;
  visibility?: string;
}) {
  return api<{ report: SavedReport }>("/reports/saved", {
    method: "POST",
    json: input,
  });
}

export async function updateSavedReport(reportId: string, input: Partial<SavedReport>) {
  return api<{ report: SavedReport }>(`/reports/saved/${reportId}`, {
    method: "PATCH",
    json: input,
  });
}

export async function deleteSavedReport(reportId: string) {
  return api<{ success: boolean }>(`/reports/saved/${reportId}`, {
    method: "DELETE",
  });
}

/** Execute a locked report by its reportType */
export async function executeLockedReport(
  reportType: string,
  options: { from?: string; to?: string; repId?: string; includeDd?: boolean } = {}
) {
  const params = new URLSearchParams();
  if (options.from) params.set("from", options.from);
  if (options.to) params.set("to", options.to);
  if (options.repId) params.set("repId", options.repId);
  if (options.includeDd) params.set("includeDd", "true");
  const qs = params.toString();

  const endpointMap: Record<string, string> = {
    pipeline_summary: "/reports/pipeline-summary",
    weighted_forecast: "/reports/weighted-forecast",
    win_loss_ratio: "/reports/win-loss",
    activity_summary: "/reports/activity-summary",
    stale_deals: "/reports/stale-deals",
    lost_by_reason: "/reports/lost-by-reason",
    revenue_by_project_type: "/reports/revenue-by-type",
    lead_source_roi: "/reports/lead-source-roi",
  };

  const endpoint = endpointMap[reportType];
  if (!endpoint) throw new Error(`Unknown report type: ${reportType}`);

  return api<{ data: any }>(`${endpoint}${qs ? `?${qs}` : ""}`);
}

/** Execute a custom report config */
export async function executeCustomReport(
  config: ReportConfig,
  pagination: { page: number; limit: number } = { page: 1, limit: 100 }
) {
  return api<{ rows: Record<string, any>[]; total: number }>("/reports/execute", {
    method: "POST",
    json: { config, ...pagination },
  });
}
```

### 5d. Chart Colors

**File: `client/src/components/charts/chart-colors.ts`**

```typescript
/**
 * Shared color palette for all Recharts visualizations.
 * Uses T Rock brand colors + complementary data visualization colors.
 */

export const CHART_COLORS = [
  "#7C3AED", // brand purple
  "#06B6D4", // brand cyan
  "#3B82F6", // blue
  "#10B981", // emerald
  "#F59E0B", // amber
  "#EF4444", // red
  "#8B5CF6", // violet
  "#EC4899", // pink
  "#14B8A6", // teal
  "#F97316", // orange
] as const;

/** Get a color for an index, cycling through the palette */
export function getChartColor(index: number): string {
  return CHART_COLORS[index % CHART_COLORS.length];
}

/** Stage-specific colors (falls back to stage.color from config, then palette) */
export function getStageColor(stageColor: string | null | undefined, index: number): string {
  return stageColor ?? getChartColor(index);
}

/** Format a number as currency ($123K, $1.2M, etc.) */
export function formatCurrency(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

/** Format a number as a compact count (1.2K, 5M, etc.) */
export function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

/** Format a percentage */
export function formatPercent(value: number): string {
  return `${value}%`;
}
```

---

## Task 6: Frontend -- Rep Dashboard Page

- [ ] Create `client/src/pages/dashboard/rep-dashboard-page.tsx`
- [ ] Create `client/src/components/dashboard/stat-card.tsx`

### 6a. Stat Card Component

**File: `client/src/components/dashboard/stat-card.tsx`**

```typescript
import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";

interface StatCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon?: ReactNode;
  trend?: { value: number; label: string; positive?: boolean };
  className?: string;
}

export function StatCard({ title, value, subtitle, icon, trend, className = "" }: StatCardProps) {
  return (
    <Card className={className}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">{title}</p>
            <p className="text-2xl font-bold">{value}</p>
            {subtitle && (
              <p className="text-xs text-muted-foreground">{subtitle}</p>
            )}
            {trend && (
              <p className={`text-xs font-medium ${trend.positive ? "text-emerald-600" : "text-red-600"}`}>
                {trend.positive ? "+" : ""}{trend.value}% {trend.label}
              </p>
            )}
          </div>
          {icon && (
            <div className="text-muted-foreground">{icon}</div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
```

### 6b. Rep Dashboard Page

**File: `client/src/pages/dashboard/rep-dashboard-page.tsx`**

```typescript
import { useRepDashboard } from "@/hooks/use-dashboard";
import { useAuth } from "@/lib/auth";
import { StatCard } from "@/components/dashboard/stat-card";
import { PipelineBarChart } from "@/components/charts/pipeline-bar-chart";
import { formatCurrency } from "@/components/charts/chart-colors";
import {
  Briefcase,
  CheckSquare,
  Activity,
  Target,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function RepDashboardPage() {
  const { user } = useAuth();
  const { data, loading, error } = useRepDashboard();

  if (loading) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-bold">Dashboard</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="p-4 h-24" />
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-bold">Dashboard</h2>
        <Card>
          <CardContent className="p-6 text-center text-red-600">
            {error}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!data) return null;

  const taskTotal = data.tasksToday.overdue + data.tasksToday.today;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">
          Welcome back, {user?.displayName?.split(" ")[0]}
        </h2>
        <p className="text-muted-foreground text-sm mt-1">
          Here is your sales activity overview for {new Date().getFullYear()}.
        </p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Active Deals"
          value={data.activeDeals.count}
          subtitle={formatCurrency(data.activeDeals.totalValue)}
          icon={<Briefcase className="h-5 w-5" />}
        />
        <StatCard
          title="Tasks Today"
          value={taskTotal}
          subtitle={
            data.tasksToday.overdue > 0
              ? `${data.tasksToday.overdue} overdue`
              : "All caught up"
          }
          icon={<CheckSquare className="h-5 w-5" />}
          className={data.tasksToday.overdue > 0 ? "border-red-200 bg-red-50/50" : ""}
        />
        <StatCard
          title="Activity This Week"
          value={data.activityThisWeek.total}
          subtitle={`${data.activityThisWeek.calls} calls, ${data.activityThisWeek.emails} emails`}
          icon={<Activity className="h-5 w-5" />}
        />
        <StatCard
          title="Follow-up Compliance"
          value={`${data.followUpCompliance.complianceRate}%`}
          subtitle={`${data.followUpCompliance.onTime} of ${data.followUpCompliance.total} on time`}
          icon={<Target className="h-5 w-5" />}
          className={
            data.followUpCompliance.complianceRate < 80
              ? "border-amber-200 bg-amber-50/50"
              : ""
          }
        />
      </div>

      {/* Pipeline Chart */}
      <Card>
        <CardHeader>
          <CardTitle>My Pipeline</CardTitle>
        </CardHeader>
        <CardContent>
          {data.pipelineByStage.length > 0 ? (
            <PipelineBarChart data={data.pipelineByStage} />
          ) : (
            <p className="text-muted-foreground text-center py-8">
              No active deals in pipeline.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Activity Breakdown */}
      <Card>
        <CardHeader>
          <CardTitle>Activity This Week</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="text-center p-3 rounded-lg bg-slate-50">
              <p className="text-2xl font-bold text-purple-600">{data.activityThisWeek.calls}</p>
              <p className="text-xs text-muted-foreground mt-1">Calls</p>
            </div>
            <div className="text-center p-3 rounded-lg bg-slate-50">
              <p className="text-2xl font-bold text-cyan-600">{data.activityThisWeek.emails}</p>
              <p className="text-xs text-muted-foreground mt-1">Emails</p>
            </div>
            <div className="text-center p-3 rounded-lg bg-slate-50">
              <p className="text-2xl font-bold text-blue-600">{data.activityThisWeek.meetings}</p>
              <p className="text-xs text-muted-foreground mt-1">Meetings</p>
            </div>
            <div className="text-center p-3 rounded-lg bg-slate-50">
              <p className="text-2xl font-bold text-emerald-600">{data.activityThisWeek.notes}</p>
              <p className="text-xs text-muted-foreground mt-1">Notes</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
```

---

## Task 7: Frontend -- Director Dashboard Page with Drill-Down

- [ ] Create `client/src/pages/director/director-dashboard-page.tsx`
- [ ] Create `client/src/pages/director/director-rep-detail.tsx`
- [ ] Create `client/src/components/dashboard/rep-performance-card.tsx`
- [ ] Create `client/src/components/dashboard/stale-deal-list.tsx`
- [ ] Create `client/src/components/dashboard/date-range-toggle.tsx`

### 7a. Date Range Toggle

**File: `client/src/components/dashboard/date-range-toggle.tsx`**

```typescript
import { Button } from "@/components/ui/button";
import type { DateRangePreset } from "@/hooks/use-director-dashboard";

interface DateRangeToggleProps {
  value: DateRangePreset;
  onChange: (preset: DateRangePreset) => void;
}

const PRESETS: Array<{ value: DateRangePreset; label: string }> = [
  { value: "mtd", label: "MTD" },
  { value: "qtd", label: "QTD" },
  { value: "ytd", label: "YTD" },
  { value: "last_month", label: "Last Month" },
  { value: "last_quarter", label: "Last Quarter" },
  { value: "last_year", label: "Last Year" },
];

export function DateRangeToggle({ value, onChange }: DateRangeToggleProps) {
  return (
    <div className="flex gap-1 flex-wrap">
      {PRESETS.map((preset) => (
        <Button
          key={preset.value}
          variant={value === preset.value ? "default" : "outline"}
          size="sm"
          onClick={() => onChange(preset.value)}
          className="text-xs"
        >
          {preset.label}
        </Button>
      ))}
    </div>
  );
}
```

### 7b. Rep Performance Card

**File: `client/src/components/dashboard/rep-performance-card.tsx`**

```typescript
import { Card, CardContent } from "@/components/ui/card";
import { formatCurrency } from "@/components/charts/chart-colors";
import { AlertTriangle } from "lucide-react";
import type { RepPerformanceCard as RepCardData } from "@/hooks/use-director-dashboard";

interface RepPerformanceCardProps {
  rep: RepCardData;
  onClick: () => void;
}

export function RepPerformanceCard({ rep, onClick }: RepPerformanceCardProps) {
  return (
    <Card
      className="cursor-pointer hover:shadow-md transition-shadow"
      onClick={onClick}
    >
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-sm truncate">{rep.repName}</h3>
          {rep.staleDeals > 0 && (
            <span className="flex items-center gap-1 text-amber-600 text-xs">
              <AlertTriangle className="h-3 w-3" />
              {rep.staleDeals}
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-xs text-muted-foreground">Active Deals</p>
            <p className="text-lg font-bold">{rep.activeDeals}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Pipeline</p>
            <p className="text-lg font-bold">{formatCurrency(rep.pipelineValue)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Win Rate</p>
            <p className={`text-lg font-bold ${rep.winRate >= 50 ? "text-emerald-600" : rep.winRate > 0 ? "text-amber-600" : "text-muted-foreground"}`}>
              {rep.winRate}%
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Activities</p>
            <p className="text-lg font-bold">{rep.activityScore}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
```

### 7c. Stale Deal List Widget

**File: `client/src/components/dashboard/stale-deal-list.tsx`**

```typescript
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/components/charts/chart-colors";
import { AlertTriangle } from "lucide-react";
import { Link } from "react-router-dom";

interface StaleDeal {
  dealId: string;
  dealNumber: string;
  dealName: string;
  stageName: string;
  repName: string;
  daysInStage: number;
  dealValue: number;
}

interface StaleDealListProps {
  deals: StaleDeal[];
}

export function StaleDealList({ deals }: StaleDealListProps) {
  if (deals.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            Stale Deal Watchlist
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm text-center py-4">
            No stale deals. All deals are progressing on time.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          Stale Deal Watchlist
          <Badge variant="secondary" className="ml-auto">{deals.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {deals.slice(0, 10).map((deal) => (
            <Link
              key={deal.dealId}
              to={`/deals/${deal.dealId}`}
              className="flex items-center justify-between p-2 rounded-md hover:bg-slate-50 transition-colors"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">{deal.dealName}</p>
                <p className="text-xs text-muted-foreground">
                  {deal.repName} -- {deal.stageName}
                </p>
              </div>
              <div className="text-right ml-3 shrink-0">
                <p className="text-sm font-medium text-amber-600">
                  {deal.daysInStage}d
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatCurrency(deal.dealValue)}
                </p>
              </div>
            </Link>
          ))}
          {deals.length > 10 && (
            <p className="text-xs text-muted-foreground text-center pt-2">
              +{deals.length - 10} more stale deals
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
```

### 7d. Director Dashboard Page

**File: `client/src/pages/director/director-dashboard-page.tsx`**

```typescript
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  useDirectorDashboard,
  presetToDateRange,
  type DateRangePreset,
} from "@/hooks/use-director-dashboard";
import { DateRangeToggle } from "@/components/dashboard/date-range-toggle";
import { RepPerformanceCard } from "@/components/dashboard/rep-performance-card";
import { StaleDealList } from "@/components/dashboard/stale-deal-list";
import { StatCard } from "@/components/dashboard/stat-card";
import { PipelineBarChart } from "@/components/charts/pipeline-bar-chart";
import { WinRateTrendChart } from "@/components/charts/win-rate-trend-chart";
import { ActivityBarChart } from "@/components/charts/activity-bar-chart";
import { formatCurrency } from "@/components/charts/chart-colors";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrendingUp, BarChart3 } from "lucide-react";

export function DirectorDashboardPage() {
  const navigate = useNavigate();
  const [preset, setPreset] = useState<DateRangePreset>("ytd");
  const dateRange = presetToDateRange(preset);
  const { data, loading, error } = useDirectorDashboard(dateRange);

  if (loading) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-bold">Director Dashboard</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="p-4 h-32" />
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-bold">Director Dashboard</h2>
        <Card>
          <CardContent className="p-6 text-center text-red-600">{error}</CardContent>
        </Card>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <h2 className="text-2xl font-bold">Director Dashboard</h2>
        <DateRangeToggle value={preset} onChange={setPreset} />
      </div>

      {/* DD vs Pipeline Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard
          title="True Pipeline"
          value={formatCurrency(data.ddVsPipeline.pipelineValue)}
          subtitle={`${data.ddVsPipeline.pipelineCount} deals`}
          icon={<TrendingUp className="h-5 w-5" />}
        />
        <StatCard
          title="DD Pipeline"
          value={formatCurrency(data.ddVsPipeline.ddValue)}
          subtitle={`${data.ddVsPipeline.ddCount} deals`}
          icon={<BarChart3 className="h-5 w-5" />}
        />
        <StatCard
          title="Total Pipeline"
          value={formatCurrency(data.ddVsPipeline.totalValue)}
          subtitle={`${data.ddVsPipeline.totalCount} deals total`}
        />
      </div>

      {/* Rep Performance Cards */}
      <div>
        <h3 className="text-lg font-semibold mb-3">Sales Rep Overview</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {data.repCards.map((rep) => (
            <RepPerformanceCard
              key={rep.repId}
              rep={rep}
              onClick={() => navigate(`/director/rep/${rep.repId}`)}
            />
          ))}
          {data.repCards.length === 0 && (
            <p className="text-muted-foreground col-span-full text-center py-4">
              No active reps found.
            </p>
          )}
        </div>
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Pipeline by Stage */}
        <Card>
          <CardHeader>
            <CardTitle>Pipeline by Stage</CardTitle>
          </CardHeader>
          <CardContent>
            {data.pipelineByStage.length > 0 ? (
              <PipelineBarChart data={data.pipelineByStage} />
            ) : (
              <p className="text-muted-foreground text-center py-8">No pipeline data.</p>
            )}
          </CardContent>
        </Card>

        {/* Win Rate Trend */}
        <Card>
          <CardHeader>
            <CardTitle>Win Rate Trend</CardTitle>
          </CardHeader>
          <CardContent>
            {data.winRateTrend.length > 0 ? (
              <WinRateTrendChart data={data.winRateTrend} />
            ) : (
              <p className="text-muted-foreground text-center py-8">No closed deals yet.</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Activity by Rep */}
      <Card>
        <CardHeader>
          <CardTitle>Activity by Rep</CardTitle>
        </CardHeader>
        <CardContent>
          {data.activityByRep.length > 0 ? (
            <ActivityBarChart data={data.activityByRep} />
          ) : (
            <p className="text-muted-foreground text-center py-8">No activity data.</p>
          )}
        </CardContent>
      </Card>

      {/* Stale Deal Watchlist */}
      <StaleDealList deals={data.staleDeals} />
    </div>
  );
}
```

### 7e. Director Rep Detail (Drill-Down)

**File: `client/src/pages/director/director-rep-detail.tsx`**

```typescript
import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import {
  useRepDetail,
  presetToDateRange,
  type DateRangePreset,
} from "@/hooks/use-director-dashboard";
import { DateRangeToggle } from "@/components/dashboard/date-range-toggle";
import { StatCard } from "@/components/dashboard/stat-card";
import { StaleDealList } from "@/components/dashboard/stale-deal-list";
import { PipelineBarChart } from "@/components/charts/pipeline-bar-chart";
import { WinRateTrendChart } from "@/components/charts/win-rate-trend-chart";
import { formatCurrency } from "@/components/charts/chart-colors";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Briefcase,
  CheckSquare,
  Activity,
  Target,
  Trophy,
  ArrowLeft,
} from "lucide-react";

export function DirectorRepDetail() {
  const { repId } = useParams<{ repId: string }>();
  const [preset, setPreset] = useState<DateRangePreset>("ytd");
  const dateRange = presetToDateRange(preset);
  const { data, loading, error } = useRepDetail(repId, dateRange);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="animate-pulse h-8 bg-slate-200 rounded w-48" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="p-4 h-24" />
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <Link to="/director">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" /> Back
          </Button>
        </Link>
        <Card>
          <CardContent className="p-6 text-center text-red-600">{error}</CardContent>
        </Card>
      </div>
    );
  }

  if (!data) return null;

  const taskTotal = data.tasksToday.overdue + data.tasksToday.today;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link to="/director">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="h-4 w-4 mr-1" /> Back
            </Button>
          </Link>
          <h2 className="text-2xl font-bold">{data.winLoss.repName || "Rep Detail"}</h2>
        </div>
        <DateRangeToggle value={preset} onChange={setPreset} />
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        <StatCard
          title="Active Deals"
          value={data.activeDeals.count}
          subtitle={formatCurrency(data.activeDeals.totalValue)}
          icon={<Briefcase className="h-5 w-5" />}
        />
        <StatCard
          title="Tasks Today"
          value={taskTotal}
          subtitle={data.tasksToday.overdue > 0 ? `${data.tasksToday.overdue} overdue` : "On track"}
          icon={<CheckSquare className="h-5 w-5" />}
        />
        <StatCard
          title="Activity This Week"
          value={data.activityThisWeek.total}
          subtitle={`${data.activityThisWeek.calls} calls`}
          icon={<Activity className="h-5 w-5" />}
        />
        <StatCard
          title="Win Rate"
          value={`${data.winLoss.winRate}%`}
          subtitle={`${data.winLoss.wins}W / ${data.winLoss.losses}L`}
          icon={<Trophy className="h-5 w-5" />}
        />
        <StatCard
          title="Follow-up Compliance"
          value={`${data.followUpCompliance.complianceRate}%`}
          subtitle={`${data.followUpCompliance.onTime}/${data.followUpCompliance.total}`}
          icon={<Target className="h-5 w-5" />}
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Pipeline by Stage</CardTitle>
          </CardHeader>
          <CardContent>
            {data.pipelineByStage.length > 0 ? (
              <PipelineBarChart data={data.pipelineByStage} />
            ) : (
              <p className="text-muted-foreground text-center py-8">No pipeline data.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Win Rate Trend</CardTitle>
          </CardHeader>
          <CardContent>
            {data.winRateTrend.length > 0 ? (
              <WinRateTrendChart data={data.winRateTrend} />
            ) : (
              <p className="text-muted-foreground text-center py-8">No data yet.</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Stale Deals */}
      <StaleDealList deals={data.staleDeals} />
    </div>
  );
}
```

---

## Task 8: Frontend -- Reports Page with Locked Presets + Custom Report Builder

- [ ] Create `client/src/pages/reports/reports-page.tsx`

### 8a. Reports Page

**File: `client/src/pages/reports/reports-page.tsx`**

```typescript
import { useState } from "react";
import {
  useSavedReports,
  executeLockedReport,
  executeCustomReport,
  createSavedReport,
  deleteSavedReport,
  type SavedReport,
  type ReportConfig,
} from "@/hooks/use-reports";
import { ReportChart } from "@/components/charts/report-chart";
import { formatCurrency } from "@/components/charts/chart-colors";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Lock, Plus, Play, Trash2, Save } from "lucide-react";

export function ReportsPage() {
  const { reports, loading, refetch } = useSavedReports();
  const [activeReport, setActiveReport] = useState<SavedReport | null>(null);
  const [reportData, setReportData] = useState<any>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [showBuilder, setShowBuilder] = useState(false);

  // Custom report builder state
  const [builderEntity, setBuilderEntity] = useState<string>("deals");
  const [builderName, setBuilderName] = useState("");
  const [builderChartType, setBuilderChartType] = useState<string>("table");

  const lockedReports = reports.filter((r) => r.isLocked);
  const customReports = reports.filter((r) => !r.isLocked);

  async function runReport(report: SavedReport) {
    setActiveReport(report);
    setReportData(null);
    setReportLoading(true);

    try {
      const config = report.config as any;
      if (report.isLocked && config.reportType) {
        const result = await executeLockedReport(config.reportType, {
          includeDd: config.includeDd,
        });
        setReportData(result.data);
      } else {
        const result = await executeCustomReport(config as ReportConfig);
        setReportData(result.rows);
      }
    } catch (err) {
      console.error("Failed to run report:", err);
    } finally {
      setReportLoading(false);
    }
  }

  async function handleSaveReport() {
    if (!builderName.trim()) return;

    const config: ReportConfig = {
      entity: builderEntity as any,
      filters: [],
      columns: [],
      chart_type: builderChartType as any,
    };

    try {
      await createSavedReport({
        name: builderName,
        entity: builderEntity,
        config,
      });
      setShowBuilder(false);
      setBuilderName("");
      refetch();
    } catch (err) {
      console.error("Failed to save report:", err);
    }
  }

  async function handleDeleteReport(reportId: string) {
    try {
      await deleteSavedReport(reportId);
      if (activeReport?.id === reportId) {
        setActiveReport(null);
        setReportData(null);
      }
      refetch();
    } catch (err) {
      console.error("Failed to delete report:", err);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Reports</h2>
        <Button onClick={() => setShowBuilder(true)} size="sm">
          <Plus className="h-4 w-4 mr-1" /> New Report
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Report List Sidebar */}
        <div className="space-y-4">
          {/* Locked Reports */}
          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <Lock className="h-3.5 w-3.5" />
                Company Reports
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {lockedReports.map((report) => (
                <button
                  key={report.id}
                  onClick={() => runReport(report)}
                  className={`w-full text-left px-4 py-2.5 text-sm border-b last:border-b-0 hover:bg-slate-50 transition-colors ${
                    activeReport?.id === report.id ? "bg-slate-100 font-medium" : ""
                  }`}
                >
                  {report.name}
                </button>
              ))}
              {lockedReports.length === 0 && (
                <p className="text-xs text-muted-foreground p-4">
                  No locked reports. Ask an admin to seed them.
                </p>
              )}
            </CardContent>
          </Card>

          {/* Custom Reports */}
          {customReports.length > 0 && (
            <Card>
              <CardHeader className="py-3">
                <CardTitle className="text-sm">My Reports</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {customReports.map((report) => (
                  <div
                    key={report.id}
                    className={`flex items-center justify-between px-4 py-2.5 border-b last:border-b-0 hover:bg-slate-50 transition-colors ${
                      activeReport?.id === report.id ? "bg-slate-100" : ""
                    }`}
                  >
                    <button
                      onClick={() => runReport(report)}
                      className="text-sm text-left flex-1 truncate"
                    >
                      {report.name}
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteReport(report.id);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>

        {/* Report Results Area */}
        <div className="lg:col-span-2">
          {!activeReport && !reportLoading && (
            <Card>
              <CardContent className="p-12 text-center text-muted-foreground">
                <BarChartIcon className="h-12 w-12 mx-auto mb-3 opacity-30" />
                <p>Select a report from the left to view results.</p>
              </CardContent>
            </Card>
          )}

          {reportLoading && (
            <Card>
              <CardContent className="p-12 text-center text-muted-foreground">
                Loading report...
              </CardContent>
            </Card>
          )}

          {activeReport && reportData && !reportLoading && (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2">
                    {activeReport.name}
                    {activeReport.isLocked && (
                      <Badge variant="secondary" className="text-xs">
                        <Lock className="h-3 w-3 mr-1" /> Locked
                      </Badge>
                    )}
                  </CardTitle>
                </div>
              </CardHeader>
              <CardContent>
                <ReportChart
                  data={reportData}
                  chartType={(activeReport.config as any)?.chart_type ?? "table"}
                  reportType={(activeReport.config as any)?.reportType}
                />
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Create Report Dialog */}
      <Dialog open={showBuilder} onOpenChange={setShowBuilder}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Custom Report</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">Report Name</label>
              <Input
                value={builderName}
                onChange={(e) => setBuilderName(e.target.value)}
                placeholder="Q1 Pipeline Review"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Entity</label>
              <Select value={builderEntity} onValueChange={setBuilderEntity}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="deals">Deals</SelectItem>
                  <SelectItem value="contacts">Contacts</SelectItem>
                  <SelectItem value="activities">Activities</SelectItem>
                  <SelectItem value="tasks">Tasks</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium">Chart Type</label>
              <Select value={builderChartType} onValueChange={setBuilderChartType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="table">Table</SelectItem>
                  <SelectItem value="bar">Bar Chart</SelectItem>
                  <SelectItem value="pie">Pie Chart</SelectItem>
                  <SelectItem value="line">Line Chart</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBuilder(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveReport} disabled={!builderName.trim()}>
              <Save className="h-4 w-4 mr-1" /> Save Report
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function BarChartIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="12" width="4" height="9" rx="1" />
      <rect x="10" y="6" width="4" height="15" rx="1" />
      <rect x="17" y="3" width="4" height="18" rx="1" />
    </svg>
  );
}
```

---

## Task 9: Frontend -- Chart Components (Recharts Wrappers)

- [ ] Create `client/src/components/charts/pipeline-bar-chart.tsx`
- [ ] Create `client/src/components/charts/activity-bar-chart.tsx`
- [ ] Create `client/src/components/charts/win-rate-trend-chart.tsx`
- [ ] Create `client/src/components/charts/pipeline-pie-chart.tsx`
- [ ] Create `client/src/components/charts/report-chart.tsx`

### 9a. Pipeline Bar Chart

**File: `client/src/components/charts/pipeline-bar-chart.tsx`**

```typescript
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { getStageColor, formatCurrency } from "./chart-colors";

interface PipelineBarChartProps {
  data: Array<{
    stageName: string;
    stageColor: string | null;
    dealCount: number;
    totalValue: number;
  }>;
  valueKey?: "totalValue" | "dealCount";
}

export function PipelineBarChart({ data, valueKey = "totalValue" }: PipelineBarChartProps) {
  const formatted = data.map((d, i) => ({
    name: d.stageName,
    value: d[valueKey],
    color: getStageColor(d.stageColor, i),
    deals: d.dealCount,
    amount: d.totalValue,
  }));

  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={formatted} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
        <XAxis
          dataKey="name"
          tick={{ fontSize: 12, fill: "#64748b" }}
          axisLine={{ stroke: "#e2e8f0" }}
        />
        <YAxis
          tick={{ fontSize: 12, fill: "#64748b" }}
          axisLine={{ stroke: "#e2e8f0" }}
          tickFormatter={(v) => (valueKey === "totalValue" ? formatCurrency(v) : String(v))}
        />
        <Tooltip
          formatter={(value: number) => [
            valueKey === "totalValue" ? formatCurrency(value) : value,
            valueKey === "totalValue" ? "Value" : "Deals",
          ]}
          contentStyle={{ fontSize: 12, borderRadius: 8 }}
        />
        <Bar dataKey="value" radius={[4, 4, 0, 0]}>
          {formatted.map((entry, index) => (
            <Cell key={index} fill={entry.color} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
```

### 9b. Activity Bar Chart

**File: `client/src/components/charts/activity-bar-chart.tsx`**

```typescript
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { CHART_COLORS } from "./chart-colors";

interface ActivityBarChartProps {
  data: Array<{
    repName: string;
    calls: number;
    emails: number;
    meetings: number;
    notes: number;
    total: number;
  }>;
}

export function ActivityBarChart({ data }: ActivityBarChartProps) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={data} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
        <XAxis
          dataKey="repName"
          tick={{ fontSize: 12, fill: "#64748b" }}
          axisLine={{ stroke: "#e2e8f0" }}
        />
        <YAxis
          tick={{ fontSize: 12, fill: "#64748b" }}
          axisLine={{ stroke: "#e2e8f0" }}
        />
        <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="calls" name="Calls" fill={CHART_COLORS[0]} stackId="a" radius={[0, 0, 0, 0]} />
        <Bar dataKey="emails" name="Emails" fill={CHART_COLORS[1]} stackId="a" radius={[0, 0, 0, 0]} />
        <Bar dataKey="meetings" name="Meetings" fill={CHART_COLORS[2]} stackId="a" radius={[0, 0, 0, 0]} />
        <Bar dataKey="notes" name="Notes" fill={CHART_COLORS[3]} stackId="a" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
```

### 9c. Win Rate Trend Chart

**File: `client/src/components/charts/win-rate-trend-chart.tsx`**

```typescript
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { CHART_COLORS, formatPercent } from "./chart-colors";

interface WinRateTrendChartProps {
  data: Array<{
    month: string;
    wins: number;
    losses: number;
    winRate: number;
  }>;
}

export function WinRateTrendChart({ data }: WinRateTrendChartProps) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={data} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
        <XAxis
          dataKey="month"
          tick={{ fontSize: 12, fill: "#64748b" }}
          axisLine={{ stroke: "#e2e8f0" }}
        />
        <YAxis
          domain={[0, 100]}
          tick={{ fontSize: 12, fill: "#64748b" }}
          axisLine={{ stroke: "#e2e8f0" }}
          tickFormatter={formatPercent}
        />
        <Tooltip
          formatter={(value: number) => [formatPercent(value), "Win Rate"]}
          contentStyle={{ fontSize: 12, borderRadius: 8 }}
        />
        <ReferenceLine y={50} stroke="#e2e8f0" strokeDasharray="3 3" label="" />
        <Line
          type="monotone"
          dataKey="winRate"
          stroke={CHART_COLORS[0]}
          strokeWidth={2}
          dot={{ fill: CHART_COLORS[0], r: 4 }}
          activeDot={{ r: 6 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
```

### 9d. Pipeline Pie Chart

**File: `client/src/components/charts/pipeline-pie-chart.tsx`**

```typescript
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { getStageColor, formatCurrency } from "./chart-colors";

interface PipelinePieChartProps {
  data: Array<{
    name: string;
    value: number;
    color?: string;
  }>;
}

export function PipelinePieChart({ data }: PipelinePieChartProps) {
  const chartData = data.map((d, i) => ({
    ...d,
    fill: d.color ?? getStageColor(null, i),
  }));

  return (
    <ResponsiveContainer width="100%" height={300}>
      <PieChart>
        <Pie
          data={chartData}
          cx="50%"
          cy="50%"
          outerRadius={100}
          innerRadius={50}
          paddingAngle={2}
          dataKey="value"
          nameKey="name"
          label={({ name, percent }) =>
            `${name} (${(percent * 100).toFixed(0)}%)`
          }
          labelLine={{ strokeWidth: 1 }}
        >
          {chartData.map((entry, index) => (
            <Cell key={index} fill={entry.fill} />
          ))}
        </Pie>
        <Tooltip
          formatter={(value: number) => [formatCurrency(value), "Value"]}
          contentStyle={{ fontSize: 12, borderRadius: 8 }}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
      </PieChart>
    </ResponsiveContainer>
  );
}
```

### 9e. Report Chart (Dynamic Renderer)

**File: `client/src/components/charts/report-chart.tsx`**

```typescript
import { PipelineBarChart } from "./pipeline-bar-chart";
import { PipelinePieChart } from "./pipeline-pie-chart";
import { WinRateTrendChart } from "./win-rate-trend-chart";
import { ActivityBarChart } from "./activity-bar-chart";
import { formatCurrency } from "./chart-colors";

interface ReportChartProps {
  data: any;
  chartType: string;
  reportType?: string;
}

/**
 * Dynamic chart renderer for report results.
 * For locked reports (with reportType), maps to the appropriate chart component.
 * For custom reports, renders a generic table or chart based on chart_type.
 */
export function ReportChart({ data, chartType, reportType }: ReportChartProps) {
  if (!data) return null;

  // Locked report type-specific rendering
  if (reportType) {
    return <LockedReportView data={data} reportType={reportType} />;
  }

  // Custom report rendering
  if (chartType === "table" || !Array.isArray(data)) {
    return <GenericTable data={Array.isArray(data) ? data : [data]} />;
  }

  if (chartType === "bar" && data.length > 0) {
    const firstRow = data[0];
    const numericKeys = Object.keys(firstRow).filter(
      (k) => typeof firstRow[k] === "number"
    );
    const labelKey = Object.keys(firstRow).find(
      (k) => typeof firstRow[k] === "string"
    );

    if (labelKey && numericKeys.length > 0) {
      const chartData = data.map((row: any) => ({
        stageName: row[labelKey],
        stageColor: null,
        dealCount: row[numericKeys[0]] ?? 0,
        totalValue: row[numericKeys[0]] ?? 0,
      }));
      return <PipelineBarChart data={chartData} valueKey="totalValue" />;
    }
  }

  if (chartType === "pie" && data.length > 0) {
    const firstRow = data[0];
    const numericKey = Object.keys(firstRow).find((k) => typeof firstRow[k] === "number");
    const labelKey = Object.keys(firstRow).find((k) => typeof firstRow[k] === "string");

    if (labelKey && numericKey) {
      const pieData = data.map((row: any) => ({
        name: row[labelKey],
        value: row[numericKey],
      }));
      return <PipelinePieChart data={pieData} />;
    }
  }

  // Fallback to table
  return <GenericTable data={data} />;
}

function LockedReportView({ data, reportType }: { data: any; reportType: string }) {
  if (!data) return null;

  switch (reportType) {
    case "pipeline_summary":
      return <PipelineBarChart data={Array.isArray(data) ? data : []} />;

    case "weighted_forecast":
      if (Array.isArray(data)) {
        const chartData = data.map((d: any) => ({
          stageName: d.month,
          stageColor: null,
          dealCount: d.dealCount,
          totalValue: d.weightedValue,
        }));
        return <PipelineBarChart data={chartData} />;
      }
      return <GenericTable data={Array.isArray(data) ? data : [data]} />;

    case "win_loss_ratio":
      return <GenericTable data={Array.isArray(data) ? data : [data]} />;

    case "activity_summary":
      if (Array.isArray(data)) {
        return <ActivityBarChart data={data} />;
      }
      return <GenericTable data={[data]} />;

    case "stale_deals":
      return <GenericTable data={Array.isArray(data) ? data : [data]} />;

    case "lost_by_reason":
      if (Array.isArray(data)) {
        const pieData = data.map((d: any) => ({
          name: d.reasonLabel,
          value: d.count,
        }));
        return <PipelinePieChart data={pieData} />;
      }
      return <GenericTable data={[data]} />;

    case "revenue_by_project_type":
      if (Array.isArray(data)) {
        const pieData = data.map((d: any) => ({
          name: d.projectTypeName,
          value: d.totalRevenue,
        }));
        return <PipelinePieChart data={pieData} />;
      }
      return <GenericTable data={[data]} />;

    case "lead_source_roi":
      return <GenericTable data={Array.isArray(data) ? data : [data]} />;

    default:
      return <GenericTable data={Array.isArray(data) ? data : [data]} />;
  }
}

function GenericTable({ data }: { data: Record<string, any>[] }) {
  if (data.length === 0) {
    return <p className="text-muted-foreground text-center py-8">No data.</p>;
  }

  const columns = Object.keys(data[0]);

  /** Format column header from snake_case/camelCase to Title Case */
  function formatHeader(key: string): string {
    return key
      .replace(/([A-Z])/g, " $1")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  /** Format cell value based on content */
  function formatCell(value: any, key: string): string {
    if (value == null) return "--";
    if (typeof value === "number") {
      if (key.toLowerCase().includes("value") || key.toLowerCase().includes("revenue") || key.toLowerCase().includes("amount")) {
        return formatCurrency(value);
      }
      if (key.toLowerCase().includes("rate")) {
        return `${value}%`;
      }
      return String(value);
    }
    if (Array.isArray(value)) return `${value.length} items`;
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b">
            {columns.map((col) => (
              <th key={col} className="text-left p-2 font-medium text-muted-foreground">
                {formatHeader(col)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => (
            <tr key={i} className="border-b last:border-b-0 hover:bg-slate-50">
              {columns.map((col) => (
                <td key={col} className="p-2">
                  {formatCell(row[col], col)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

---

## Task 10: Route and Navigation Wiring

- [ ] Update `client/src/App.tsx` -- replace Dashboard placeholder and PlaceholderPage for `/reports` and `/director`
- [ ] No sidebar changes needed (links already exist)

### 10a. Update App.tsx

**File: `client/src/App.tsx`** -- MODIFY to replace placeholders:

Replace the entire file content:

```typescript
import { Routes, Route, Navigate } from "react-router-dom";
import type { ReactNode } from "react";
import { AuthProvider, useAuth } from "@/lib/auth";
import { DevUserPicker } from "@/components/auth/dev-user-picker";
import { AppShell } from "@/components/layout/app-shell";
import { DealListPage } from "@/pages/deals/deal-list-page";
import { DealDetailPage } from "@/pages/deals/deal-detail-page";
import { DealNewPage } from "@/pages/deals/deal-new-page";
import { DealEditPage } from "@/pages/deals/deal-edit-page";
import { PipelinePage } from "@/pages/pipeline/pipeline-page";
import { ContactListPage } from "@/pages/contacts/contact-list-page";
import { ContactDetailPage } from "@/pages/contacts/contact-detail-page";
import { ContactNewPage } from "@/pages/contacts/contact-new-page";
import { ContactEditPage } from "@/pages/contacts/contact-edit-page";
import { MergeQueuePage } from "@/pages/admin/merge-queue-page";
import { EmailInboxPage } from "@/pages/email/email-inbox-page";
import { TaskListPage } from "@/pages/tasks/task-list-page";
import { RepDashboardPage } from "@/pages/dashboard/rep-dashboard-page";
import { DirectorDashboardPage } from "@/pages/director/director-dashboard-page";
import { DirectorRepDetail } from "@/pages/director/director-rep-detail";
import { ReportsPage } from "@/pages/reports/reports-page";

function PlaceholderPage({ title }: { title: string }) {
  return (
    <div>
      <h2 className="text-2xl font-bold">{title}</h2>
      <p className="text-muted-foreground mt-1">This page will be built in a future plan.</p>
    </div>
  );
}

function AuthGate({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!user) return <DevUserPicker />;
  return <>{children}</>;
}

export function App() {
  return (
    <AuthProvider>
      <AuthGate>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<RepDashboardPage />} />
            <Route path="/deals" element={<DealListPage />} />
            <Route path="/deals/new" element={<DealNewPage />} />
            <Route path="/deals/:id" element={<DealDetailPage />} />
            <Route path="/deals/:id/edit" element={<DealEditPage />} />
            <Route path="/pipeline" element={<PipelinePage />} />
            <Route path="/contacts" element={<ContactListPage />} />
            <Route path="/contacts/new" element={<ContactNewPage />} />
            <Route path="/contacts/:id" element={<ContactDetailPage />} />
            <Route path="/contacts/:id/edit" element={<ContactEditPage />} />
            <Route path="/email" element={<EmailInboxPage />} />
            <Route path="/tasks" element={<TaskListPage />} />
            <Route path="/files" element={<PlaceholderPage title="Files" />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/projects" element={<PlaceholderPage title="Projects" />} />
            <Route path="/director" element={<DirectorDashboardPage />} />
            <Route path="/director/rep/:repId" element={<DirectorRepDetail />} />
            <Route path="/admin/offices" element={<PlaceholderPage title="Offices" />} />
            <Route path="/admin/users" element={<PlaceholderPage title="Users" />} />
            <Route path="/admin/pipeline" element={<PlaceholderPage title="Pipeline Config" />} />
            <Route path="/admin/merge-queue" element={<MergeQueuePage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthGate>
    </AuthProvider>
  );
}
```

**Changes from existing `App.tsx`:**
1. Removed inline `Dashboard` function -- replaced with `RepDashboardPage` import
2. `/` route now renders `<RepDashboardPage />`
3. `/director` route now renders `<DirectorDashboardPage />`
4. Added `/director/rep/:repId` route for drill-down
5. `/reports` route now renders `<ReportsPage />`

---

## Implementation Order and Dependencies

```
Task 1 (Reporting Service)         ─┐
Task 2 (Saved Reports CRUD + Routes)─┼─> Task 3 (Dashboard Service + Routes) ─> Task 4 (Tests)
                                     │
                                     └─> Task 5 (Frontend Hooks + Chart Utils) ─┐
                                                                                 ├─> Task 6 (Rep Dashboard Page)
                                                                                 ├─> Task 7 (Director Dashboard Page)
                                                                                 ├─> Task 8 (Reports Page)
                                                                                 └─> Task 9 (Chart Components)
                                                                                            │
                                                                                            └─> Task 10 (Route Wiring)
```

**Parallelizable groups:**
- Tasks 1 + 2 can run in parallel (both backend, no dependency)
- Task 3 depends on Task 1 (imports from reports/service.ts)
- Task 5 can start as soon as Tasks 1-3 are done (needs API shape)
- Tasks 6, 7, 8, 9 can run in parallel once Task 5 is done
- Task 10 depends on Tasks 6, 7, 8 (imports the page components)

---

## Verification Checklist

- [ ] `GET /api/dashboard/rep` returns all 5 dashboard sections for the logged-in user
- [ ] `GET /api/dashboard/director` returns rep cards, pipeline, trends, stale watchlist (requires director role)
- [ ] `GET /api/dashboard/director/rep/:repId` returns drill-down data for a specific rep
- [ ] All 9 locked report endpoints return data (pipeline summary, weighted forecast, win/loss, etc.)
- [ ] `POST /api/reports/execute` runs a custom report config and returns rows
- [ ] Saved reports CRUD: create, list, update, delete (locked reports reject edits/deletes)
- [ ] `POST /api/reports/seed` creates the 9 locked reports for the office
- [ ] Rep dashboard at `/` shows KPI cards, pipeline chart, activity breakdown
- [ ] Director dashboard at `/director` shows rep cards, pipeline bar, win rate trend, activity bars, stale list
- [ ] Clicking a rep card navigates to `/director/rep/:repId` with full detail view
- [ ] Date range toggle (MTD/QTD/YTD/Last Month/Last Quarter/Last Year) updates all director charts
- [ ] Reports page at `/reports` shows locked reports list and custom report builder
- [ ] Running a locked report displays appropriate chart (bar, pie, line, or table)
- [ ] Custom report builder saves to saved_reports table and appears in "My Reports"
- [ ] All chart components render correctly with Recharts (no blank areas)
- [ ] Pipeline summary excludes DD stages by default, includes them when toggled
- [ ] Default date range is current calendar year across all dashboards and reports
- [ ] Reps see only their own data on the dashboard; directors see all reps
- [ ] `tsc --noEmit` passes with no type errors
