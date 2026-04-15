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

export interface StaleLeadDashboardRow {
  leadId: string;
  leadName: string;
  companyName: string;
  propertyName: string;
  stageName: string;
  repName: string;
  daysInStage: number;
}

async function getStaleLeadWatchlist(
  tenantDb: TenantDb,
  options: { repId?: string } = {}
): Promise<StaleLeadDashboardRow[]> {
  const repFilter = options.repId
    ? sql`AND l.assigned_rep_id = ${options.repId}`
    : sql``;

  const result = await tenantDb.execute(sql`
    SELECT
      l.id AS lead_id,
      l.name AS lead_name,
      c.name AS company_name,
      p.name AS property_name,
      psc.name AS stage_name,
      u.display_name AS rep_name,
      EXTRACT(DAY FROM NOW() - l.stage_entered_at)::int AS days_in_stage
    FROM leads l
    JOIN companies c ON c.id = l.company_id
    JOIN properties p ON p.id = l.property_id
    JOIN pipeline_stage_config psc ON psc.id = l.stage_id
    JOIN users u ON u.id = l.assigned_rep_id
    WHERE l.is_active = true
      AND l.status = 'open'
      AND psc.workflow_family = 'lead'
      AND psc.is_terminal = false
      AND psc.stale_threshold_days IS NOT NULL
      AND l.stage_entered_at < NOW() - (psc.stale_threshold_days || ' days')::interval
      ${repFilter}
    ORDER BY days_in_stage DESC, l.updated_at ASC
  `);

  const rows = (result as any).rows ?? result;
  return rows.map((row: any) => ({
    leadId: row.lead_id,
    leadName: row.lead_name,
    companyName: row.company_name,
    propertyName: row.property_name,
    stageName: row.stage_name,
    repName: row.rep_name,
    daysInStage: Number(row.days_in_stage ?? 0),
  }));
}

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
  staleLeads: {
    count: number;
    averageDaysInStage: number | null;
    leads: StaleLeadDashboardRow[];
  };
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
    staleLeadResult,
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

    getStaleLeadWatchlist(tenantDb, { repId: userId }),
  ]);

  const adRows = (activeDealResult as any).rows ?? activeDealResult;
  const tcRows = (taskCountResult as any).rows ?? taskCountResult;
  const acRows = (activityResult as any).rows ?? activityResult;
  const plRows = (pipelineResult as any).rows ?? pipelineResult;
  const staleLeadAverage = staleLeadResult.length > 0
    ? Math.round(staleLeadResult.reduce((sum, lead) => sum + lead.daysInStage, 0) / staleLeadResult.length)
    : null;

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
    staleLeads: {
      count: staleLeadResult.length,
      averageDaysInStage: staleLeadAverage,
      leads: staleLeadResult,
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
  staleLeads: StaleLeadDashboardRow[];
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
    staleLeadResult,
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

    // 6. Stale leads watchlist
    getStaleLeadWatchlist(tenantDb),

    // 7. DD vs pipeline
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
    staleLeads: staleLeadResult,
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
    ),
    rep_stale_leads AS (
      SELECT
        l.assigned_rep_id AS rep_id,
        COUNT(*)::int AS stale_lead_count
      FROM leads l
      JOIN pipeline_stage_config psc ON psc.id = l.stage_id
      WHERE l.is_active = true
        AND l.status = 'open'
        AND psc.workflow_family = 'lead'
        AND psc.is_terminal = false
        AND psc.stale_threshold_days IS NOT NULL
        AND EXTRACT(DAY FROM NOW() - l.stage_entered_at) > psc.stale_threshold_days
      GROUP BY l.assigned_rep_id
    )
    SELECT
      u.id AS rep_id,
      u.display_name AS rep_name,
      COALESCE(rd.active_deals, 0)::int AS active_deals,
      COALESCE(rd.pipeline_value, 0)::numeric AS pipeline_value,
      COALESCE(rw.wins, 0)::int AS wins,
      COALESCE(rw.losses, 0)::int AS losses,
      COALESCE(ra.total, 0)::int AS activity_score,
      COALESCE(rs.stale_count, 0)::int AS stale_deals,
      COALESCE(rsl.stale_lead_count, 0)::int AS stale_leads
    FROM users u
    LEFT JOIN rep_deals rd ON rd.rep_id = u.id
    LEFT JOIN rep_wins rw ON rw.rep_id = u.id
    LEFT JOIN rep_activities ra ON ra.rep_id = u.id
    LEFT JOIN rep_stale rs ON rs.rep_id = u.id
    LEFT JOIN rep_stale_leads rsl ON rsl.rep_id = u.id
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
      staleLeads: Number(r.stale_leads ?? 0),
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

  const [dashboard, winLoss, winTrend, staleDeals, staleLeads] = await Promise.all([
    getRepDashboard(tenantDb, repId),
    getWinLossRatioByRep(tenantDb, { from, to }),
    getWinRateTrend(tenantDb, { from, to, repId }),
    getStaleDeals(tenantDb, { repId }),
    getStaleLeadWatchlist(tenantDb, { repId }),
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
