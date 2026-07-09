import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  companies,
  dealPaymentEvents,
  dealSignedCommissions,
  deals,
  pipelineStageConfig,
  properties,
  userCommissionSettings,
  users,
} from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import type { UserRole } from "@trock-crm/shared/types";
import { WON_DEAL_STAGE_SLUGS } from "@trock-crm/shared/types";
import { aliasedActiveDealCountFilterSql, aliasedDealBestEstimateSql } from "../shared/deal-value-sql.js";
// Estimator-aware rep filter (PR 2): the DEAL filter matches assigned_rep OR estimator_user_id. This is
// a view-filter change ONLY — commission attribution (dsc.rep_user_id) and rate (cs.user_id) are untouched.
import { buildAliasedInvolvedRepSql, UNASSIGNED_FILTER_SENTINEL } from "../deals/deal-filter-predicates.js";
import { estimatorRateJoinSql, involvedPotentialRateSql } from "./potential-rate-sql.js";
import { computeRepEarnedFloorGate } from "./floor-gate.js";

type TenantDb = NodePgDatabase<typeof schema>;

export interface CommissionReportFilters {
  role: UserRole;
  userId: string;
  repId?: string;
  from?: string;
  to?: string;
  stages?: string[];
}

export interface CommissionStagePotential {
  stageId: string;
  stageName: string;
  stageSlug: string;
  displayOrder: number;
  dealCount: number;
  totalDealValue: number;
  potentialCommission: number;
}

export interface CommissionEarnedMonth {
  month: string;
  earnedCommission: number;
  dealCount: number;
}

export interface CommissionDealRow {
  dealId: string;
  dealNumber: string | null;
  dealName: string;
  repId: string;
  repName: string;
  stageName: string;
  stageSlug: string;
  sourceValueAmount: number;
  appliedRate: number;
  earnedCommission: number;
  contractSignedDate: string | null;
  paidYtd: number;
}

export interface CommissionSummary {
  earnedMtd: number;
  earnedYtd: number;
  potentialPipeline: number;
  paidYtd: number;
}

export type CommissionPeriod = "mtd" | "qtd" | "ytd" | "all";

export interface RepCommissionDashboardDeal {
  dealId: string;
  repId: string;
  dealNumber: string | null;
  dealName: string;
  companyName: string | null;
  propertyName: string | null;
  propertyAddress: string | null;
  stageKey: "won" | "contract" | "estimate_sent" | "estimating" | "opportunity";
  stageName: string;
  stageSlug: string;
  dealValue: number;
  commissionRate: number;
  commission: number;
  deltaCommission: number | null;
  contractSignedDate: string | null;
  expectedCloseDate: string | null;
  daysInStage: number;
  isEarned: boolean;
}

export interface RepCommissionDashboard {
  period: CommissionPeriod;
  dateRange: { from: string | null; to: string | null };
  formula: string;
  goal: { amount: number; percentToGoal: number | null; source: "none" };
  summary: {
    earned: number;
    inPipeline: number;
    totalPotential: number;
    openDealCount: number;
    // Deals sitting in a Won stage that have NO contract-signed date yet, so they mint no commission and
    // are absent from both `earned` (needs a signed date) and `inPipeline` (pipeline stages only). Surfaced
    // as a distinct "awaiting contract signature" figure so won-but-unsigned value is visible, not lost.
    wonAwaitingSignature: {
      dealCount: number;
      dealValue: number;
      potentialCommission: number;
    };
  };
  stageTotals: Array<{
    stageKey: RepCommissionDashboardDeal["stageKey"];
    stageName: string;
    commission: number;
    dealValue: number;
    dealCount: number;
    percentOfTotal: number;
  }>;
  deals: RepCommissionDashboardDeal[];
}

function numberFrom(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function textFrom(value: unknown): string {
  return value == null ? "" : String(value);
}

function dateFrom(value: unknown): string | null {
  if (!value) return null;
  return String(value).slice(0, 10);
}

export function effectiveCommissionRepId(filters: CommissionReportFilters): string | undefined {
  return filters.role === "rep" ? filters.userId : filters.repId;
}

function effectiveRepForRepDashboard(filters: CommissionReportFilters): string {
  return filters.role === "rep" ? filters.userId : (filters.repId ?? filters.userId);
}

// Exported for the runtime test that proves the commission DEAL filter is estimator-aware.
export function repSql(filters: CommissionReportFilters) {
  const repId = effectiveCommissionRepId(filters);
  return repId ? sql`AND ${buildAliasedInvolvedRepSql("d", repId)}` : sql``;
}

function commissionRepSql(filters: CommissionReportFilters) {
  const repId = effectiveCommissionRepId(filters);
  return repId ? sql`AND dsc.rep_user_id = ${repId}` : sql``;
}

function dateSql(filters: CommissionReportFilters, field: "commission" | "payment") {
  const column =
    field === "commission"
      ? earnedSignedDateSql()
      : sql`pe.paid_at::date`;

  return sql`
    ${filters.from ? sql`AND ${column} >= ${filters.from}` : sql``}
    ${filters.to ? sql`AND ${column} <= ${filters.to}` : sql``}
  `;
}

function stageSql(filters: CommissionReportFilters) {
  const stages = (filters.stages ?? []).map((stage) => stage.trim()).filter(Boolean);
  if (stages.length === 0) return sql``;
  return sql`AND psc.slug = ANY(${stages})`;
}

function potentialStageSql() {
  // Intentionally includes canonical stage-v2 slugs plus historical aliases so
  // commission potential stays accurate while legacy rows still exist during rollout.
  return sql`AND psc.slug IN ('contract', 'opportunity', 'estimating', 'service_estimating', 'estimate_under_review', 'estimate_sent_to_client', 'estimate_in_progress', 'service_estimate_under_review', 'service_estimate_sent_to_client')`;
}

function unsignedDealSql() {
  return sql`AND d.contract_signed_at IS NULL AND d.contract_signed_date IS NULL`;
}

function notLostStageSql() {
  return sql`AND psc.slug NOT IN ('lost', 'production_lost', 'service_lost', 'closed_lost')`;
}

function notOnHoldDealSql() {
  return sql`AND ${aliasedActiveDealCountFilterSql("d")}`;
}

function potentialCommissionSql(repId?: string) {
  const dealValue = sql`(${aliasedDealBestEstimateSql("d")} + COALESCE(d.change_order_total, 0))`;
  // The Unassigned bucket (repId === UNASSIGNED_FILTER_SENTINEL) is scoped by repSql/buildAliasedInvolvedRepSql
  // to `assigned_rep_id IS NULL` rows. It has no single involved rep, so we must NOT interpolate the sentinel
  // string into the per-rep rate CASE (which compares it against uuid columns and 22P02-errors). Fall through
  // to the office-wide formula: for a NULL owner the cs join yields no row → owner arm 0, and the additive
  // estimator arm still contributes — exactly the correct unassigned-owner potential.
  if (repId && repId !== UNASSIGNED_FILTER_SENTINEL) {
    return sql`${dealValue} * ${involvedPotentialRateSql(repId)}`;
  }
  return sql`${dealValue} * (
    COALESCE(cs.commission_rate, 0)::numeric
    + CASE
        WHEN d.estimator_user_id IS NOT NULL AND d.estimator_user_id IS DISTINCT FROM d.assigned_rep_id
          THEN COALESCE(ecs.commission_rate, 0)::numeric
        ELSE 0::numeric
      END
  )`;
}

function signedDealSql() {
  return sql`AND COALESCE(d.contract_signed_at::date, d.contract_signed_date, dsc.contract_signed_date_at_signing) IS NOT NULL`;
}

function earnedSignedDateSql() {
  return sql`COALESCE(d.contract_signed_at::date, d.contract_signed_date, dsc.contract_signed_date_at_signing)`;
}

function currentUtcSummaryBounds(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    monthStart: new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10),
    yearStart: new Date(Date.UTC(year, 0, 1)).toISOString().slice(0, 10),
  };
}

export function describeCommissionFormula(): string {
  return [
    "Potential commission includes unsigned active deals in Contract, Opportunity, Estimating, Estimate Under Review, or Estimate Sent to Client, including historical aliases during rollout.",
    "Earned commission is recognized when contract_signed_at is set, with contract_signed_date as the historical compatibility fallback.",
    "Won deals remain earned after handoff; Lost deals are excluded from potential and earned commission totals.",
    "On-hold deals are excluded from potential and earned commission while they remain on hold.",
    "Earned commission source value resolves in this order: awarded_amount, then bid_estimate, then dd_estimate.",
    "Potential commission uses the current unsigned deal value: bid_board_total_sales, then bid_estimate, then dd_estimate, with awarded_amount only as a fallback.",
    "Owner commission amount = source_value_amount * user_commission_settings.commission_rate, rounded to cents.",
    "Estimator commission uses the estimator user's own active commission_rate, independent of the project owner's rate.",
    "Potential pipeline uses active unsigned deal value plus change orders, multiplied by the role-appropriate rate.",
  ].join(" ");
}

export function getCommissionPeriodDateRange(
  period: CommissionPeriod,
  now = new Date()
): { from: string | null; to: string | null } {
  if (period === "all") return { from: null, to: null };
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const to = now.toISOString().slice(0, 10);
  const fromDate =
    period === "mtd"
      ? new Date(Date.UTC(year, month, 1))
      : period === "qtd"
        ? new Date(Date.UTC(year, Math.floor(month / 3) * 3, 1))
        : new Date(Date.UTC(year, 0, 1));
  return { from: fromDate.toISOString().slice(0, 10), to };
}

export function normalizeCommissionPeriod(value: unknown): CommissionPeriod {
  return value === "mtd" || value === "qtd" || value === "ytd" || value === "all" ? value : "ytd";
}

const STAGE_ORDER: RepCommissionDashboardDeal["stageKey"][] = [
  "won",
  "contract",
  "estimate_sent",
  "estimating",
  "opportunity",
];

const STAGE_LABELS: Record<RepCommissionDashboardDeal["stageKey"], string> = {
  won: "Won",
  contract: "Contract",
  estimate_sent: "Estimate Sent",
  estimating: "Estimating",
  opportunity: "Opportunity",
};

function stageKeyFromSlug(slug: string, isEarned: boolean): RepCommissionDashboardDeal["stageKey"] | null {
  if (isEarned) return "won";
  if (slug === "contract") return "contract";
  if (slug === "estimate_sent_to_client" || slug === "service_estimate_sent_to_client") return "estimate_sent";
  if (
    slug === "estimating" ||
    slug === "service_estimating" ||
    slug === "estimate_under_review" ||
    slug === "estimate_in_progress" ||
    slug === "service_estimate_under_review"
  ) {
    return "estimating";
  }
  if (slug === "opportunity") return "opportunity";
  return null;
}

function normalizeDashboardRow(row: any): RepCommissionDashboardDeal | null {
  const isEarned = Boolean(row.is_earned);
  const stageSlug = textFrom(row.stage_slug);
  const stageKey = stageKeyFromSlug(stageSlug, isEarned);
  if (!stageKey) return null;
  const commission = numberFrom(row.commission);
  const snapshotAmount = row.snapshot_commission_amount == null ? null : numberFrom(row.snapshot_commission_amount);
  const delta = snapshotAmount == null ? null : Number((commission - snapshotAmount).toFixed(2));
  return {
    dealId: textFrom(row.deal_id),
    repId: textFrom(row.rep_id),
    dealNumber: row.deal_number ? textFrom(row.deal_number) : null,
    dealName: textFrom(row.deal_name),
    companyName: row.company_name ? textFrom(row.company_name) : null,
    propertyName: row.property_name ? textFrom(row.property_name) : null,
    propertyAddress: row.property_address ? textFrom(row.property_address) : null,
    stageKey,
    stageName: STAGE_LABELS[stageKey],
    stageSlug,
    dealValue: numberFrom(row.deal_value),
    commissionRate: numberFrom(row.commission_rate),
    commission,
    deltaCommission: delta && Math.abs(delta) >= 0.01 ? delta : null,
    contractSignedDate: dateFrom(row.contract_signed_date),
    expectedCloseDate: dateFrom(row.expected_close_date),
    daysInStage: numberFrom(row.days_in_stage),
    isEarned,
  };
}

async function refreshCommissionSnapshots(
  tenantDb: TenantDb,
  dealsForSnapshot: RepCommissionDashboardDeal[],
  dashboardRepId: string
) {
  // Only refresh snapshots for rows projected for the dashboard rep. Owned rows and estimator-only rows both
  // carry rep_id = dashboardRepId; owner rows viewed through an estimator filter never overwrite owner state.
  const snapshotRows = dealsForSnapshot.filter((deal) => deal.repId === dashboardRepId);
  if (snapshotRows.length === 0) return;
  await tenantDb.execute(sql`
    INSERT INTO commission_deal_snapshots (
      deal_id,
      rep_user_id,
      last_commission_amount,
      last_computed_at
    )
    VALUES ${sql.join(
      snapshotRows.map((deal) => sql`(
        ${deal.dealId}::uuid,
        ${deal.repId}::uuid,
        ${String(deal.commission)}::numeric,
        now()
      )`),
      sql`, `
    )}
    ON CONFLICT (deal_id, rep_user_id) DO UPDATE
      SET last_commission_amount = EXCLUDED.last_commission_amount,
          last_computed_at = EXCLUDED.last_computed_at
  `);
}

export async function getRepCommissionDashboard(
  tenantDb: TenantDb,
  filters: CommissionReportFilters & { period?: CommissionPeriod; skipSnapshotRefresh?: boolean }
): Promise<RepCommissionDashboard> {
  const period = filters.period ?? "ytd";
  const periodRange = getCommissionPeriodDateRange(period);
  const dateRange = {
    from: filters.from ?? periodRange.from,
    to: filters.to ?? periodRange.to,
  };
  const repId = effectiveRepForRepDashboard(filters);
  const result = await tenantDb.execute(sql`
    WITH commission_rows AS (
      SELECT
        d.id AS deal_id,
        d.deal_number,
        d.name AS deal_name,
        dsc.rep_user_id AS rep_id,
        c.name AS company_name,
        p.name AS property_name,
        COALESCE(p.address, d.property_address) AS property_address,
        psc.slug AS stage_slug,
        dsc.source_value_amount::numeric AS deal_value,
        dsc.applied_rate::numeric AS commission_rate,
        dsc.amount::numeric AS commission,
        COALESCE(d.contract_signed_at::date, d.contract_signed_date, dsc.contract_signed_date_at_signing) AS contract_signed_date,
        d.expected_close_date,
        GREATEST(0, CURRENT_DATE - COALESCE(d.stage_entered_at::date, d.updated_at::date, d.created_at::date))::int AS days_in_stage,
        true AS is_earned,
        cds.last_commission_amount AS snapshot_commission_amount
      FROM ${dealSignedCommissions} dsc
      JOIN ${deals} d ON d.id = dsc.deal_id
      JOIN ${pipelineStageConfig} psc ON psc.id = d.stage_id
      LEFT JOIN ${companies} c ON c.id = d.company_id
      LEFT JOIN ${properties} p ON p.id = d.property_id
      LEFT JOIN commission_deal_snapshots cds ON cds.deal_id = d.id AND cds.rep_user_id = dsc.rep_user_id
      WHERE dsc.rep_user_id = ${repId}
        AND COALESCE(d.is_test_data, false) = false
        AND COALESCE(d.contract_signed_at::date, d.contract_signed_date, dsc.contract_signed_date_at_signing) IS NOT NULL
        AND psc.slug NOT IN ('lost', 'production_lost', 'service_lost', 'closed_lost')
        ${notOnHoldDealSql()}
        ${dateRange.from ? sql`AND COALESCE(d.contract_signed_at::date, d.contract_signed_date, dsc.contract_signed_date_at_signing) >= ${dateRange.from}::date` : sql``}
        ${dateRange.to ? sql`AND COALESCE(d.contract_signed_at::date, d.contract_signed_date, dsc.contract_signed_date_at_signing) <= ${dateRange.to}::date` : sql``}

      UNION ALL

      SELECT
        d.id AS deal_id,
        d.deal_number,
        d.name AS deal_name,
        CASE
          WHEN d.assigned_rep_id = ${repId} THEN d.assigned_rep_id
          WHEN d.estimator_user_id = ${repId} THEN d.estimator_user_id
          ELSE d.assigned_rep_id
        END AS rep_id,
        c.name AS company_name,
        p.name AS property_name,
        COALESCE(p.address, d.property_address) AS property_address,
        psc.slug AS stage_slug,
        (${aliasedDealBestEstimateSql("d")} + COALESCE(d.change_order_total, 0))::numeric AS deal_value,
        ${involvedPotentialRateSql(repId)} AS commission_rate,
        ROUND(
          (${potentialCommissionSql(repId)})::numeric,
          2
        )::numeric AS commission,
        NULL::date AS contract_signed_date,
        d.expected_close_date,
        GREATEST(0, CURRENT_DATE - COALESCE(d.stage_entered_at::date, d.updated_at::date, d.created_at::date))::int AS days_in_stage,
        false AS is_earned,
        cds.last_commission_amount AS snapshot_commission_amount
      FROM ${deals} d
      JOIN ${pipelineStageConfig} psc ON psc.id = d.stage_id
      LEFT JOIN ${userCommissionSettings} cs ON cs.user_id = d.assigned_rep_id AND cs.is_active = true
      ${estimatorRateJoinSql()}
      LEFT JOIN ${companies} c ON c.id = d.company_id
      LEFT JOIN ${properties} p ON p.id = d.property_id
      -- Read the snapshot keyed on the DASHBOARD rep (not necessarily the owner): estimator-visible rows
      -- project the estimator user's own cut, so their delta also belongs to the estimator.
      LEFT JOIN commission_deal_snapshots cds ON cds.deal_id = d.id AND cds.rep_user_id = ${repId}
      WHERE ${buildAliasedInvolvedRepSql("d", repId)}
        AND d.is_active = true
        AND COALESCE(d.is_test_data, false) = false
        AND d.contract_signed_at IS NULL
        AND d.contract_signed_date IS NULL
        ${notOnHoldDealSql()}
        AND psc.slug IN (
          'contract',
          'opportunity',
          'estimating',
          'service_estimating',
          'estimate_under_review',
          'estimate_sent_to_client',
          'estimate_in_progress',
          'service_estimate_under_review',
          'service_estimate_sent_to_client'
        )
        ${dateRange.to ? sql`AND d.created_at::date <= ${dateRange.to}::date` : sql``}
        ${dateRange.from ? sql`AND (d.expected_close_date IS NULL OR d.expected_close_date >= ${dateRange.from}::date)` : sql``}
    )
    SELECT *
    FROM commission_rows
    WHERE deal_value > 0
    ORDER BY
      CASE
        WHEN is_earned THEN 1
        WHEN stage_slug = 'contract' THEN 2
        WHEN stage_slug IN ('estimate_sent_to_client', 'service_estimate_sent_to_client') THEN 3
        WHEN stage_slug IN ('estimating', 'service_estimating', 'estimate_under_review', 'estimate_in_progress', 'service_estimate_under_review') THEN 4
        ELSE 5
      END,
      commission DESC,
      deal_name ASC
  `);

  const rows: RepCommissionDashboardDeal[] = ((result as any).rows ?? result)
    .map(normalizeDashboardRow)
    .filter((row: RepCommissionDashboardDeal | null): row is RepCommissionDashboardDeal => row != null);
  // The snapshot write powers each deal's "since last update" delta — it belongs to the rep VIEWING their
  // own page. A director's read-only "View as rep" must NOT mutate the rep's snapshots (it would reset the
  // rep's deltas before they ever see them), so callers can opt out.
  if (!filters.skipSnapshotRefresh) {
    await refreshCommissionSnapshots(tenantDb, rows, repId);
  }

  // Floor gate (single source of truth — the same helper Engine B and the manager-override roll-up use).
  // While the rep's qualifying revenue is below their floor, earned commission is $0 — both per-deal and
  // the page total. We gate AFTER the snapshot write so the snapshot keeps each deal's intrinsic (ungated)
  // commission for "since last update" deltas; only the displayed earned figures zero out. The breakdown
  // rows stay listed (just $0). Pipeline (unsigned) rows are a separate metric and are never gated.
  const floorGate = await computeRepEarnedFloorGate(tenantDb, repId, dateRange);
  if (!floorGate.met) {
    for (const deal of rows) {
      if (deal.isEarned) {
        deal.commission = 0;
        deal.deltaCommission = null;
      }
    }
  }

  const earned = Number(rows.filter((deal) => deal.isEarned).reduce((sum, deal) => sum + deal.commission, 0).toFixed(2));
  const inPipeline = Number(rows.filter((deal) => !deal.isEarned).reduce((sum, deal) => sum + deal.commission, 0).toFixed(2));
  const totalPotential = Number((earned + inPipeline).toFixed(2));

  // Won-stage deals with NO contract-signed date: they mint no commission row, so they fall through both
  // `earned` (signed only) and `inPipeline` (pipeline stages only). Aggregate them separately — same
  // value × role-appropriate rate basis as the pipeline-potential query — so the won-but-unsigned total is visible.
  //  • Full Won family (WON_DEAL_STAGE_SLUGS), not just won/closed_won, so won-stage aliases count.
  //  • Exclude deals already booked for this rep (a legacy/reconciled dsc row can carry
  //    contract_signed_date_at_signing while deal-level signed fields are null — the earned branch already
  //    counts those, so including them here would double-show one deal as earned AND awaiting-signature).
  //  • When a period window applies, require a real won_closed_date (no NULL passthrough) so undated wins
  //    don't bleed into every MTD/QTD/YTD window.
  const wonUnsignedResult = await tenantDb.execute(sql`
    SELECT
      COUNT(*)::int AS deal_count,
      COALESCE(SUM(${aliasedDealBestEstimateSql("d")} + COALESCE(d.change_order_total, 0)), 0)::numeric AS deal_value,
      COALESCE(SUM(
        ${potentialCommissionSql(repId)}
      ), 0)::numeric AS potential_commission
    FROM ${deals} d
    JOIN ${pipelineStageConfig} psc ON psc.id = d.stage_id
    LEFT JOIN ${userCommissionSettings} cs ON cs.user_id = d.assigned_rep_id AND cs.is_active = true
    ${estimatorRateJoinSql()}
    WHERE ${buildAliasedInvolvedRepSql("d", repId)}
      AND d.is_active = true
      AND COALESCE(d.is_test_data, false) = false
      AND d.contract_signed_at IS NULL
      AND d.contract_signed_date IS NULL
      AND psc.slug IN (${sql.join(WON_DEAL_STAGE_SLUGS.map((slug) => sql`${slug}`), sql`, `)})
      ${notOnHoldDealSql()}
      AND NOT EXISTS (
        SELECT 1 FROM ${dealSignedCommissions} x WHERE x.deal_id = d.id AND x.rep_user_id = ${repId}
      )
      ${dateRange.from ? sql`AND d.won_closed_date >= ${dateRange.from}::date` : sql``}
      ${dateRange.to ? sql`AND d.won_closed_date <= ${dateRange.to}::date` : sql``}
  `);
  const wonUnsignedRow = (((wonUnsignedResult as any).rows ?? wonUnsignedResult)[0] ?? {}) as Record<string, unknown>;
  const wonAwaitingSignature = {
    dealCount: numberFrom(wonUnsignedRow.deal_count),
    dealValue: numberFrom(wonUnsignedRow.deal_value),
    potentialCommission: numberFrom(wonUnsignedRow.potential_commission),
  };
  const stageTotals = STAGE_ORDER.map((stageKey) => {
    const stageDeals = rows.filter((deal) => deal.stageKey === stageKey);
    const commission = Number(stageDeals.reduce((sum, deal) => sum + deal.commission, 0).toFixed(2));
    const dealValue = Number(stageDeals.reduce((sum, deal) => sum + deal.dealValue, 0).toFixed(2));
    return {
      stageKey,
      stageName: STAGE_LABELS[stageKey],
      commission,
      dealValue,
      dealCount: stageDeals.length,
      percentOfTotal: totalPotential > 0 ? Number(((commission / totalPotential) * 100).toFixed(1)) : 0,
    };
  });

  return {
    period,
    dateRange,
    formula: "Commission = deal value × role rate. Estimator cuts use the estimator user's active rate; earned locks when a contract is signed.",
    goal: { amount: 0, percentToGoal: null, source: "none" },
    summary: {
      earned,
      inPipeline,
      totalPotential,
      openDealCount: rows.filter((deal) => !deal.isEarned).length,
      wonAwaitingSignature,
    },
    stageTotals,
    deals: rows,
  };
}

export async function getCommissionPotential(
  tenantDb: TenantDb,
  filters: CommissionReportFilters
): Promise<{ formula: string; stageGroups: CommissionStagePotential[] }> {
  const result = await tenantDb.execute(sql`
    SELECT
      psc.id AS stage_id,
      psc.name AS stage_name,
      psc.slug AS stage_slug,
      psc.display_order,
      COUNT(*)::int AS deal_count,
      COALESCE(SUM(${aliasedDealBestEstimateSql("d")} + COALESCE(d.change_order_total, 0)), 0)::numeric AS total_deal_value,
      COALESCE(
        SUM(
          ${potentialCommissionSql(effectiveCommissionRepId(filters))}
        ),
        0
      )::numeric AS potential_commission
    FROM ${deals} d
    JOIN ${pipelineStageConfig} psc ON psc.id = d.stage_id
    LEFT JOIN ${userCommissionSettings} cs ON cs.user_id = d.assigned_rep_id AND cs.is_active = true
    ${estimatorRateJoinSql()}
    WHERE d.is_active = true
      AND COALESCE(d.is_test_data, false) = false
      ${potentialStageSql()}
      ${unsignedDealSql()}
      ${notOnHoldDealSql()}
      ${repSql(filters)}
      ${stageSql(filters)}
    GROUP BY psc.id, psc.name, psc.slug, psc.display_order
    ORDER BY psc.display_order ASC, psc.name ASC
  `);

  const rows = (result as any).rows ?? result;
  return {
    formula: describeCommissionFormula(),
    stageGroups: rows.map((row: any) => ({
      stageId: textFrom(row.stage_id),
      stageName: textFrom(row.stage_name),
      stageSlug: textFrom(row.stage_slug),
      displayOrder: numberFrom(row.display_order),
      dealCount: numberFrom(row.deal_count),
      totalDealValue: numberFrom(row.total_deal_value),
      potentialCommission: numberFrom(row.potential_commission),
    })),
  };
}

export async function getCommissionEarned(
  tenantDb: TenantDb,
  filters: CommissionReportFilters
): Promise<{ months: CommissionEarnedMonth[]; deals: CommissionDealRow[] }> {
  const utcBounds = currentUtcSummaryBounds();
  const monthResult = await tenantDb.execute(sql`
    SELECT
      TO_CHAR(DATE_TRUNC('month', ${earnedSignedDateSql()}), 'YYYY-MM') AS month,
      COALESCE(SUM(dsc.amount), 0)::numeric AS earned_commission,
      COUNT(DISTINCT dsc.deal_id)::int AS deal_count
    FROM ${dealSignedCommissions} dsc
    JOIN ${deals} d ON d.id = dsc.deal_id
    JOIN ${pipelineStageConfig} psc ON psc.id = d.stage_id
    WHERE COALESCE(d.is_test_data, false) = false
      ${signedDealSql()}
      ${notLostStageSql()}
      ${notOnHoldDealSql()}
      ${commissionRepSql(filters)}
      ${dateSql(filters, "commission")}
      ${stageSql(filters)}
    GROUP BY DATE_TRUNC('month', ${earnedSignedDateSql()})
    ORDER BY DATE_TRUNC('month', ${earnedSignedDateSql()}) ASC
  `);

  const dealsResult = await tenantDb.execute(sql`
    SELECT
      d.id AS deal_id,
      d.deal_number,
      d.name AS deal_name,
      u.id AS rep_id,
      u.display_name AS rep_name,
      psc.name AS stage_name,
      psc.slug AS stage_slug,
      dsc.source_value_amount,
      dsc.applied_rate,
      dsc.amount AS earned_commission,
      dsc.contract_signed_date_at_signing AS contract_signed_date,
      COALESCE(SUM(
        CASE
          WHEN pe.paid_at::date >= ${utcBounds.yearStart}::date
            THEN CASE WHEN pe.is_credit_memo THEN -ABS(pe.gross_revenue_amount::numeric) ELSE ABS(pe.gross_revenue_amount::numeric) END
          ELSE 0
        END
      ), 0)::numeric AS paid_ytd
    FROM ${dealSignedCommissions} dsc
    JOIN ${deals} d ON d.id = dsc.deal_id
    JOIN ${users} u ON u.id = dsc.rep_user_id
    JOIN ${pipelineStageConfig} psc ON psc.id = d.stage_id
    LEFT JOIN ${dealPaymentEvents} pe ON pe.deal_id = d.id
    WHERE COALESCE(d.is_test_data, false) = false
      ${signedDealSql()}
      ${notLostStageSql()}
      ${notOnHoldDealSql()}
      ${commissionRepSql(filters)}
      ${dateSql(filters, "commission")}
      ${stageSql(filters)}
    GROUP BY d.id, d.deal_number, d.name, u.id, u.display_name, psc.name, psc.slug, dsc.source_value_amount, dsc.applied_rate, dsc.amount, dsc.contract_signed_date_at_signing
    ORDER BY ${earnedSignedDateSql()} DESC, d.name ASC
  `);

  const monthRows = (monthResult as any).rows ?? monthResult;
  const dealRows = (dealsResult as any).rows ?? dealsResult;
  const earnedMonths: CommissionEarnedMonth[] = monthRows.map((row: any) => ({
    month: textFrom(row.month),
    earnedCommission: numberFrom(row.earned_commission),
    dealCount: numberFrom(row.deal_count),
  }));
  const earnedDeals: CommissionDealRow[] = dealRows.map((row: any) => ({
    dealId: textFrom(row.deal_id),
    dealNumber: row.deal_number ? textFrom(row.deal_number) : null,
    dealName: textFrom(row.deal_name),
    repId: textFrom(row.rep_id),
    repName: textFrom(row.rep_name),
    stageName: textFrom(row.stage_name),
    stageSlug: textFrom(row.stage_slug),
    sourceValueAmount: numberFrom(row.source_value_amount),
    appliedRate: numberFrom(row.applied_rate),
    earnedCommission: numberFrom(row.earned_commission),
    contractSignedDate: dateFrom(row.contract_signed_date),
    paidYtd: numberFrom(row.paid_ytd),
  }));

  // Floor gate (same helper as the engines). Applied to the SINGLE-REP scope only — when the request
  // resolves to one rep (always for a rep viewing their own; a director drilling into a repId). If that
  // rep is below floor for the window, earned commission zeroes out (rows stay listed for the breakdown;
  // paidYtd is actual payments, not gated). The director ALL-reps aggregate (no repId) stays gross —
  // per-rep gating of an aggregate is a separate concern and there is no consumer of it today.
  const earnedRepId = effectiveCommissionRepId(filters);
  if (earnedRepId) {
    const gate = await computeRepEarnedFloorGate(tenantDb, earnedRepId, {
      from: filters.from ?? null,
      to: filters.to ?? null,
    });
    if (!gate.met) {
      return {
        months: earnedMonths.map((m) => ({ ...m, earnedCommission: 0 })),
        deals: earnedDeals.map((d) => ({ ...d, earnedCommission: 0 })),
      };
    }
  }
  return { months: earnedMonths, deals: earnedDeals };
}

export async function getCommissionSummary(
  tenantDb: TenantDb,
  filters: CommissionReportFilters
): Promise<CommissionSummary> {
  const utcBounds = currentUtcSummaryBounds();
  const result = await tenantDb.execute(sql`
    WITH earned AS (
      SELECT
        COALESCE(SUM(dsc.amount) FILTER (
          WHERE ${earnedSignedDateSql()} >= ${utcBounds.monthStart}::date
        ), 0)::numeric AS earned_mtd,
        COALESCE(SUM(dsc.amount) FILTER (
          WHERE ${earnedSignedDateSql()} >= ${utcBounds.yearStart}::date
        ), 0)::numeric AS earned_ytd
      FROM ${dealSignedCommissions} dsc
      JOIN ${deals} d ON d.id = dsc.deal_id
      JOIN ${pipelineStageConfig} psc ON psc.id = d.stage_id
      WHERE COALESCE(d.is_test_data, false) = false
        ${signedDealSql()}
        ${notLostStageSql()}
        ${notOnHoldDealSql()}
        ${commissionRepSql(filters)}
        ${dateSql(filters, "commission")}
        ${stageSql(filters)}
    ),
    potential AS (
      SELECT
        COALESCE(
          SUM(
            ${potentialCommissionSql(effectiveCommissionRepId(filters))}
          ),
          0
        )::numeric AS potential_pipeline
      FROM ${deals} d
      JOIN ${pipelineStageConfig} psc ON psc.id = d.stage_id
      LEFT JOIN ${userCommissionSettings} cs ON cs.user_id = d.assigned_rep_id AND cs.is_active = true
      ${estimatorRateJoinSql()}
      WHERE d.is_active = true
        AND COALESCE(d.is_test_data, false) = false
        ${potentialStageSql()}
        ${unsignedDealSql()}
        ${notOnHoldDealSql()}
        ${repSql(filters)}
        ${stageSql(filters)}
    ),
    paid AS (
      SELECT
        COALESCE(SUM(
          CASE WHEN pe.is_credit_memo THEN -ABS(pe.gross_revenue_amount::numeric) ELSE ABS(pe.gross_revenue_amount::numeric) END
        ), 0)::numeric AS paid_ytd
      FROM ${dealPaymentEvents} pe
      JOIN ${deals} d ON d.id = pe.deal_id
      JOIN ${pipelineStageConfig} psc ON psc.id = d.stage_id
      WHERE pe.paid_at::date >= ${utcBounds.yearStart}::date
        AND COALESCE(d.is_test_data, false) = false
        ${notOnHoldDealSql()}
        ${repSql(filters)}
        ${stageSql(filters)}
    )
    SELECT earned.earned_mtd, earned.earned_ytd, potential.potential_pipeline, paid.paid_ytd
    FROM earned, potential, paid
  `);

  const rows = (result as any).rows ?? result;
  const row = rows[0] ?? {};
  let earnedMtd = numberFrom(row.earned_mtd);
  let earnedYtd = numberFrom(row.earned_ytd);

  // Floor gate (single-rep scope, same helper as the engines): MTD and YTD earned each gate on the rep's
  // floor over the SAME effective window the earned CTE uses. The CTE bounds earned by max(period-start,
  // filters.from)..filters.to (the FILTER's period-start AND the outer dateSql), so the gate must use the
  // later of the period start and filters.from — otherwise revenue before filters.from could release a
  // filtered window whose own qualifying revenue is below floor. Aggregate (no repId) stays gross.
  const summaryRepId = effectiveCommissionRepId(filters);
  if (summaryRepId) {
    const laterDate = (periodStart: string, from: string | undefined) =>
      from && from > periodStart ? from : periodStart;
    // Serialized, NOT Promise.all: tenantDb is bound to ONE pooled client that runs queries serially, so a
    // parallel fan-out just queues the second behind the first — and the pool-level query_timeout counts
    // that queue wait against the timer, so a healthy second query could spuriously time out under load.
    const mtdGate = await computeRepEarnedFloorGate(tenantDb, summaryRepId, {
      from: laterDate(utcBounds.monthStart, filters.from),
      to: filters.to ?? null,
    });
    const ytdGate = await computeRepEarnedFloorGate(tenantDb, summaryRepId, {
      from: laterDate(utcBounds.yearStart, filters.from),
      to: filters.to ?? null,
    });
    if (!mtdGate.met) earnedMtd = 0;
    if (!ytdGate.met) earnedYtd = 0;
  }

  return {
    earnedMtd,
    earnedYtd,
    potentialPipeline: numberFrom(row.potential_pipeline),
    paidYtd: numberFrom(row.paid_ytd),
  };
}
