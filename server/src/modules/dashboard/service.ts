import { eq, and, sql, gte, lte, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  auditLog,
  aiDisconnectCases,
  deals,
  dealPaymentEvents,
  leads,
  activities,
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

export interface FunnelBucketSummary {
  key: "lead" | "qualified_lead" | "opportunity" | "due_diligence" | "estimating";
  label: string;
  count: number;
  totalValue: number | null;
  route: "/leads" | "/deals";
  bucket: "lead" | "qualified_lead" | "opportunity" | "due_diligence" | "estimating";
}

export interface DirectorRepFunnelRow {
  repId: string;
  repName: string;
  leads: number;
  qualifiedLeads: number;
  opportunities: number;
  dueDiligence: number;
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

function dealValueSql() {
  return sql`COALESCE(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0)`;
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
        (leadCounts.get("contacted") ?? 0),
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
        (leadCounts.get("director_go_no_go") ?? 0) +
        (leadCounts.get("ready_for_opportunity") ?? 0),
      totalValue: null,
      route: "/leads",
      bucket: "opportunity",
    },
    {
      key: "due_diligence",
      label: "Due Diligence",
      count: dealCounts.get("dd") ?? 0,
      totalValue: dealValues.get("dd") ?? 0,
      route: "/deals",
      bucket: "due_diligence",
    },
    {
      key: "estimating",
      label: "Estimating",
      count: (dealCounts.get("estimating") ?? 0) + (dealCounts.get("bid_sent") ?? 0),
      totalValue: (dealValues.get("estimating") ?? 0) + (dealValues.get("bid_sent") ?? 0),
      route: "/deals",
      bucket: "estimating",
    },
  ];
}

async function getRepFunnelBuckets(tenantDb: TenantDb, repId: string): Promise<FunnelBucketSummary[]> {
  const [leadResult, dealResult] = await Promise.all([
    tenantDb.execute(sql`
      SELECT
        psc.slug,
        COUNT(*)::int AS count
      FROM leads l
      JOIN pipeline_stage_config psc ON psc.id = l.stage_id
      WHERE l.status = 'open'
        AND l.is_active = true
        AND psc.workflow_family = 'lead'
        AND l.assigned_rep_id = ${repId}
      GROUP BY psc.slug
    `),
    tenantDb.execute(sql`
      SELECT
        psc.slug,
        COUNT(*)::int AS count,
        COALESCE(SUM(${dealValueSql()}), 0)::numeric AS total_value
      FROM deals d
      JOIN pipeline_stage_config psc ON psc.id = d.stage_id
      WHERE d.is_active = true
        AND d.assigned_rep_id = ${repId}
        AND psc.slug IN ('dd', 'estimating', 'bid_sent')
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
  const [leadResult, dealResult, repRowsResult] = await Promise.all([
    tenantDb.execute(sql`
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
    tenantDb.execute(sql`
      SELECT
        psc.slug,
        COUNT(*)::int AS count,
        COALESCE(SUM(${dealValueSql()}), 0)::numeric AS total_value
      FROM deals d
      JOIN pipeline_stage_config psc ON psc.id = d.stage_id
      WHERE d.is_active = true
        AND psc.slug IN ('dd', 'estimating', 'bid_sent')
      GROUP BY psc.slug
    `),
    tenantDb.execute(sql`
      WITH lead_counts AS (
        SELECT
          l.assigned_rep_id AS rep_id,
          COUNT(*) FILTER (
            WHERE psc.slug IN ('lead_new', 'company_pre_qualified', 'scoping_in_progress', 'contacted')
          )::int AS leads,
          COUNT(*) FILTER (
            WHERE psc.slug IN ('pre_qual_value_assigned', 'lead_go_no_go', 'qualified_lead')
          )::int AS qualified_leads,
          COUNT(*) FILTER (
            WHERE psc.slug IN ('qualified_for_opportunity', 'director_go_no_go', 'ready_for_opportunity')
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
          COUNT(*) FILTER (WHERE psc.slug = 'dd')::int AS due_diligence,
          COUNT(*) FILTER (WHERE psc.slug IN ('estimating', 'bid_sent'))::int AS estimating
        FROM deals d
        JOIN pipeline_stage_config psc ON psc.id = d.stage_id
        WHERE d.is_active = true
          AND psc.slug IN ('dd', 'estimating', 'bid_sent')
        GROUP BY d.assigned_rep_id
      )
      SELECT
        u.id AS rep_id,
        u.display_name AS rep_name,
        COALESCE(lc.leads, 0)::int AS leads,
        COALESCE(lc.qualified_leads, 0)::int AS qualified_leads,
        COALESCE(lc.opportunities, 0)::int AS opportunities,
        COALESCE(dc.due_diligence, 0)::int AS due_diligence,
        COALESCE(dc.estimating, 0)::int AS estimating
      FROM users u
      LEFT JOIN lead_counts lc ON lc.rep_id = u.id
      LEFT JOIN deal_counts dc ON dc.rep_id = u.id
      WHERE u.is_active = true
        AND u.role = 'rep'
      ORDER BY
        (
          COALESCE(lc.leads, 0) +
          COALESCE(lc.qualified_leads, 0) +
          COALESCE(lc.opportunities, 0) +
          COALESCE(dc.due_diligence, 0) +
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
    dueDiligence: Number(row.due_diligence ?? 0),
    estimating: Number(row.estimating ?? 0),
  })).sort((a: DirectorRepFunnelRow, b: DirectorRepFunnelRow) => {
    const totalA = a.leads + a.qualifiedLeads + a.opportunities + a.dueDiligence + a.estimating;
    const totalB = b.leads + b.qualifiedLeads + b.opportunities + b.dueDiligence + b.estimating;
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
  config: CommissionConfig
): Promise<DirectCommissionMetrics> {
  const windowMonths = Math.max(1, config.newCustomerWindowMonths);

  const result = await tenantDb.execute(sql`
    WITH payment_events AS (
      SELECT
        pe.id,
        pe.paid_at,
        d.company_id,
        CASE
          WHEN pe.is_credit_memo THEN -ABS(pe.gross_revenue_amount::numeric)
          ELSE ABS(pe.gross_revenue_amount::numeric)
        END AS gross_revenue_amount,
        CASE
          WHEN pe.is_credit_memo THEN -ABS(COALESCE(pe.gross_margin_amount, pe.gross_revenue_amount * ${String(config.estimatedMarginRate)}::numeric)::numeric)
          ELSE ABS(COALESCE(pe.gross_margin_amount, pe.gross_revenue_amount * ${String(config.estimatedMarginRate)}::numeric)::numeric)
        END AS gross_margin_amount,
        (pe.gross_margin_amount IS NULL) AS used_estimated_margin
      FROM ${dealPaymentEvents} pe
      JOIN ${deals} d ON d.id = pe.deal_id
      WHERE d.assigned_rep_id = ${repId}
        AND pe.paid_at >= NOW() - INTERVAL '12 months'
    ),
    scored_events AS (
      SELECT
        ev.*,
        CASE
          WHEN ev.gross_revenue_amount = 0 THEN NULL
          ELSE (ABS(ev.gross_margin_amount) / NULLIF(ABS(ev.gross_revenue_amount), 0))
        END AS margin_percent,
        NOT EXISTS (
          SELECT 1
          FROM ${activities} a
          WHERE a.company_id = ev.company_id
            AND a.occurred_at >= ev.paid_at - (${windowMonths}::text || ' months')::interval
            AND a.occurred_at < ev.paid_at
        ) AS is_new_customer
      FROM payment_events ev
    ),
    eligible_events AS (
      SELECT *
      FROM scored_events
      WHERE gross_revenue_amount < 0
        OR margin_percent IS NULL
        OR margin_percent >= ${String(config.minMarginPercent)}::numeric
    ),
    low_margin_events AS (
      SELECT *
      FROM scored_events
      WHERE gross_revenue_amount >= 0
        AND margin_percent IS NOT NULL
        AND margin_percent < ${String(config.minMarginPercent)}::numeric
    )
    SELECT
      COALESCE((SELECT SUM(gross_revenue_amount) FROM eligible_events), 0)::numeric AS rolling_paid_revenue,
      COALESCE((SELECT SUM(gross_margin_amount) FROM eligible_events), 0)::numeric AS rolling_commissionable_margin,
      COALESCE((SELECT SUM(gross_revenue_amount) FROM eligible_events WHERE is_new_customer), 0)::numeric AS new_customer_revenue,
      COALESCE((SELECT COUNT(*) FROM eligible_events WHERE used_estimated_margin), 0)::int AS estimated_payment_count,
      COALESCE((SELECT SUM(gross_revenue_amount) FROM low_margin_events), 0)::numeric AS excluded_low_margin_revenue
  `);

  const rows = (result as any).rows ?? result;
  const row = rows[0] ?? {};
  const rollingPaidRevenue = Number(row.rolling_paid_revenue ?? 0);
  const rollingCommissionableMargin = Number(row.rolling_commissionable_margin ?? 0);
  const newCustomerRevenue = Number(row.new_customer_revenue ?? 0);
  const estimatedPaymentCount = Number(row.estimated_payment_count ?? 0);
  const excludedLowMarginRevenue = Number(row.excluded_low_margin_revenue ?? 0);
  const newCustomerShare = rollingPaidRevenue > 0 ? newCustomerRevenue / rollingPaidRevenue : 0;
  const meetsNewCustomerShare = rollingPaidRevenue === 0 ? true : newCustomerShare >= config.newCustomerShareFloor;
  const floorRemaining = Math.max(config.rollingFloor - rollingPaidRevenue, 0);
  const eligibleRevenueAfterFloor = Math.max(rollingPaidRevenue - config.rollingFloor, 0);
  const realizedMarginRate =
    rollingPaidRevenue > 0 ? rollingCommissionableMargin / rollingPaidRevenue : 0;
  const eligibleMarginAfterFloor = Math.max(eligibleRevenueAfterFloor * realizedMarginRate, 0);
  const directEarnedCommission = meetsNewCustomerShare
    ? Number((eligibleMarginAfterFloor * config.commissionRate).toFixed(2))
    : 0;

  return {
    rollingPaidRevenue,
    rollingCommissionableMargin,
    newCustomerRevenue,
    newCustomerShare,
    meetsNewCustomerShare,
    estimatedPaymentCount,
    excludedLowMarginRevenue,
    floorRemaining,
    eligibleMarginAfterFloor,
    directEarnedCommission,
  };
}

async function getRepPotentialRevenue(tenantDb: TenantDb, repId: string): Promise<number> {
  const result = await tenantDb.execute(sql`
    SELECT
      COALESCE(
        SUM(
          COALESCE(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0) + COALESCE(d.change_order_total, 0)
        ),
        0
      )::numeric AS potential_revenue
    FROM ${deals} d
    JOIN ${pipelineStageConfig} psc ON psc.id = d.stage_id
    WHERE d.assigned_rep_id = ${repId}
      AND d.is_active = true
      AND psc.is_terminal = false
  `);
  const rows = (result as any).rows ?? result;
  return Number(rows[0]?.potential_revenue ?? 0);
}

async function getOverrideEarnedCommission(
  tenantDb: TenantDb,
  managerId: string,
  managerOverrideRate: number
): Promise<number> {
  if (managerOverrideRate <= 0) return 0;

  const subordinateResult = await tenantDb.execute(sql`
    SELECT u.id AS rep_id
    FROM ${users} u
    WHERE u.is_active = true
      AND u.role = 'rep'
      AND u.reports_to = ${managerId}
  `);
  const subordinateRows = (subordinateResult as any).rows ?? subordinateResult;
  if (subordinateRows.length === 0) return 0;

  const earned = await Promise.all(
    subordinateRows.map(async (row: any) => {
      const subordinateId = String(row.rep_id);
      const subordinateConfig = await getCommissionConfig(tenantDb, subordinateId);
      if (!subordinateConfig.isActive) return 0;
      const subordinateMetrics = await getDirectCommissionMetrics(tenantDb, subordinateId, subordinateConfig);
      if (!subordinateMetrics.meetsNewCustomerShare) return 0;
      return subordinateMetrics.eligibleMarginAfterFloor * managerOverrideRate;
    })
  );

  return Number(earned.reduce((sum, value) => sum + value, 0).toFixed(2));
}

async function getRepCommissionSummary(
  tenantDb: TenantDb,
  repId: string
): Promise<RepCommissionSummary> {
  const rawConfig = await getCommissionConfig(tenantDb, repId);
  const config = rawConfig.isActive
    ? rawConfig
    : {
        ...rawConfig,
        commissionRate: 0,
        rollingFloor: 0,
        overrideRate: 0,
      };
  const direct = await getDirectCommissionMetrics(tenantDb, repId, config);
  const potentialRevenue = await getRepPotentialRevenue(tenantDb, repId);
  const potentialMargin = potentialRevenue * config.estimatedMarginRate;
  const potentialEligibleRevenue = Math.max(potentialRevenue - direct.floorRemaining, 0);
  const potentialCommissionBase = potentialEligibleRevenue * config.estimatedMarginRate;
  const potentialCommission = Number((potentialCommissionBase * config.commissionRate).toFixed(2));
  const overrideEarnedCommission = await getOverrideEarnedCommission(tenantDb, repId, config.overrideRate);
  const totalEarnedCommission = Number((direct.directEarnedCommission + overrideEarnedCommission).toFixed(2));

  return {
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
  };
}

async function getDirectorRepCommissionRows(
  tenantDb: TenantDb
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

  const rows = await Promise.all(
    reps.map(async (rep: any) => {
      const summary = await getRepCommissionSummary(tenantDb, String(rep.id));
      return {
        repId: String(rep.id),
        repName: String(rep.display_name ?? "Rep"),
        totalEarnedCommission: summary.totalEarnedCommission,
        potentialCommission: summary.potentialCommission,
        floorRemaining: summary.floorRemaining,
        newCustomerShare: summary.newCustomerShare,
        meetsNewCustomerShare: summary.meetsNewCustomerShare,
      };
    })
  );

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
    activeLeadResult,
    activeDealResult,
    taskCountResult,
    activityResult,
    complianceResult,
    pipelineResult,
    staleLeadResult,
    leadSnapshotResult,
    dealSnapshotResult,
    funnelBuckets,
    commissionSummary,
  ] = await Promise.all([
    tenantDb.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM leads l
      JOIN pipeline_stage_config psc ON psc.id = l.stage_id
      WHERE l.is_active = true
        AND l.status = 'open'
        AND l.assigned_rep_id = ${userId}
        AND NOT psc.is_terminal
    `),

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
      WHERE responsible_user_id = ${userId}
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

    tenantDb.execute(sql`
      SELECT
        l.id AS lead_id,
        l.name AS lead_name,
        c.name AS company_name,
        p.name AS property_name,
        psc.name AS stage_name,
        EXTRACT(DAY FROM NOW() - l.stage_entered_at)::int AS days_in_stage,
        l.updated_at
      FROM leads l
      LEFT JOIN companies c ON c.id = l.company_id
      LEFT JOIN properties p ON p.id = l.property_id
      JOIN pipeline_stage_config psc ON psc.id = l.stage_id
      WHERE l.is_active = true
        AND l.status = 'open'
        AND l.assigned_rep_id = ${userId}
        AND NOT psc.is_terminal
      ORDER BY l.updated_at DESC
      LIMIT 5
    `),

    tenantDb.execute(sql`
      SELECT
        d.id AS deal_id,
        d.name AS deal_name,
        c.name AS company_name,
        p.name AS property_name,
        psc.name AS stage_name,
        COALESCE(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0)::numeric AS total_value,
        d.updated_at
      FROM deals d
      LEFT JOIN companies c ON c.id = d.company_id
      LEFT JOIN properties p ON p.id = d.property_id
      JOIN pipeline_stage_config psc ON psc.id = d.stage_id
      WHERE d.is_active = true
        AND d.assigned_rep_id = ${userId}
        AND NOT psc.is_terminal
      ORDER BY d.updated_at DESC
      LIMIT 5
    `),
    getRepFunnelBuckets(tenantDb, userId),
    getRepCommissionSummary(tenantDb, userId),
  ]);

  const alRows = (activeLeadResult as any).rows ?? activeLeadResult;
  const adRows = (activeDealResult as any).rows ?? activeDealResult;
  const tcRows = (taskCountResult as any).rows ?? taskCountResult;
  const acRows = (activityResult as any).rows ?? activityResult;
  const plRows = (pipelineResult as any).rows ?? pipelineResult;
  const lsRows = (leadSnapshotResult as any).rows ?? leadSnapshotResult;
  const dsRows = (dealSnapshotResult as any).rows ?? dealSnapshotResult;
  const staleLeadAverage = staleLeadResult.length > 0
    ? Math.round(staleLeadResult.reduce((sum, lead) => sum + lead.daysInStage, 0) / staleLeadResult.length)
    : null;

  return {
    activeLeads: {
      count: Number(alRows[0]?.count ?? 0),
    },
    funnelBuckets,
    commissionSummary,
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
    leadSnapshot: lsRows.map((row: any) => ({
      leadId: row.lead_id,
      leadName: row.lead_name,
      companyName: row.company_name ?? null,
      propertyName: row.property_name ?? null,
      stageName: row.stage_name,
      daysInStage: Number(row.days_in_stage ?? 0),
      updatedAt: toIsoOrNow(row.updated_at),
    })),
    dealSnapshot: dsRows.map((row: any) => ({
      dealId: row.deal_id,
      dealName: row.deal_name,
      companyName: row.company_name ?? null,
      propertyName: row.property_name ?? null,
      stageName: row.stage_name,
      totalValue: Number(row.total_value ?? 0),
      updatedAt: toIsoOrNow(row.updated_at),
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
  staleLeads: number;
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
    funnelSummary,
    repCommissionRows,
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
    getDirectorFunnelSummary(tenantDb),
    getDirectorRepCommissionRows(tenantDb),
  ]);

  return {
    officeFunnelBuckets: funnelSummary.officeFunnelBuckets,
    repFunnelRows: funnelSummary.repFunnelRows,
    repCommissionRows,
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
        a.responsible_user_id AS rep_id,
        COUNT(*)::int AS total
      FROM activities a
      WHERE a.occurred_at >= ${from}::timestamptz
        AND a.occurred_at <= (${to}::date + INTERVAL '1 day')::timestamptz
      GROUP BY a.responsible_user_id
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
  return {
    unresolvedCount: 0,
    oldestAgeLabel: "0m",
  };
}

async function readAuditSummary(tenantDb: TenantDb, _activeOfficeId: string) {
  const result = await tenantDb.execute(sql`
    select
      count(*) filter (where created_at >= now() - interval '24 hours')::int as change_count_24h,
      coalesce(max(actor_name), 'No recent changes') as last_actor_label
    from audit_log
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
  const [aiActions, interventions, disconnects, mergeQueue, migration, audit, procore] = await Promise.all([
    readAiActionSummary(tenantDb, activeOfficeId),
    readInterventionSummary(tenantDb, activeOfficeId),
    readDisconnectSummary(tenantDb, activeOfficeId),
    readMergeQueueSummary(tenantDb, activeOfficeId),
    readMigrationSummary(tenantDb, activeOfficeId),
    readAuditSummary(tenantDb, activeOfficeId),
    readProcoreSummary(tenantDb, activeOfficeId),
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
