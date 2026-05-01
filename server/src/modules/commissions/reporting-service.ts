import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  dealPaymentEvents,
  dealSignedCommissions,
  deals,
  pipelineStageConfig,
  userCommissionSettings,
  users,
} from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import type { UserRole } from "@trock-crm/shared/types";

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

function repSql(filters: CommissionReportFilters) {
  const repId = effectiveCommissionRepId(filters);
  return repId ? sql`AND d.assigned_rep_id = ${repId}` : sql``;
}

function commissionRepSql(filters: CommissionReportFilters) {
  const repId = effectiveCommissionRepId(filters);
  return repId ? sql`AND dsc.rep_user_id = ${repId}` : sql``;
}

function dateSql(filters: CommissionReportFilters, field: "commission" | "payment") {
  const column =
    field === "commission"
      ? earnedRecognitionDateSql()
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

function earnedStageSql() {
  return sql`AND psc.slug IN ('won', 'sent_to_production', 'service_sent_to_production', 'closed_won')`;
}

function earnedRecognitionDateSql() {
  return sql`COALESCE(d.actual_close_date, d.stage_entered_at::date, dsc.contract_signed_date_at_signing)`;
}

export function describeCommissionFormula(): string {
  return [
    "Booked commission is stored in deal_signed_commissions when a deal receives contract_signed_at.",
    "Earned commission reports include booked rows only after the deal reaches Won or a historical won alias.",
    "The source value resolves in this order: awarded_amount, then bid_estimate, then dd_estimate.",
    "Booked amount = source_value_amount * user_commission_settings.commission_rate, rounded to cents.",
    "Potential pipeline uses active non-terminal deal value plus change orders, multiplied by the rep estimated margin rate and commission rate.",
  ].join(" ");
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
      COALESCE(SUM(COALESCE(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0) + COALESCE(d.change_order_total, 0)), 0)::numeric AS total_deal_value,
      COALESCE(
        SUM(
          (COALESCE(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0) + COALESCE(d.change_order_total, 0))
          * COALESCE(cs.estimated_margin_rate, 0.30)
          * COALESCE(cs.commission_rate, 0)
        ),
        0
      )::numeric AS potential_commission
    FROM ${deals} d
    JOIN ${pipelineStageConfig} psc ON psc.id = d.stage_id
    LEFT JOIN ${userCommissionSettings} cs ON cs.user_id = d.assigned_rep_id AND cs.is_active = true
    WHERE d.is_active = true
      AND COALESCE(d.is_test_data, false) = false
      AND psc.is_terminal = false
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
  const monthResult = await tenantDb.execute(sql`
    SELECT
      TO_CHAR(DATE_TRUNC('month', ${earnedRecognitionDateSql()}), 'YYYY-MM') AS month,
      COALESCE(SUM(dsc.amount), 0)::numeric AS earned_commission,
      COUNT(DISTINCT dsc.deal_id)::int AS deal_count
    FROM ${dealSignedCommissions} dsc
    JOIN ${deals} d ON d.id = dsc.deal_id
    JOIN ${pipelineStageConfig} psc ON psc.id = d.stage_id
    WHERE COALESCE(d.is_test_data, false) = false
      ${earnedStageSql()}
      ${commissionRepSql(filters)}
      ${dateSql(filters, "commission")}
      ${stageSql(filters)}
    GROUP BY DATE_TRUNC('month', ${earnedRecognitionDateSql()})
    ORDER BY DATE_TRUNC('month', ${earnedRecognitionDateSql()}) ASC
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
          WHEN pe.paid_at >= DATE_TRUNC('year', CURRENT_DATE)
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
      ${earnedStageSql()}
      ${commissionRepSql(filters)}
      ${dateSql(filters, "commission")}
      ${stageSql(filters)}
    GROUP BY d.id, d.deal_number, d.name, u.id, u.display_name, psc.name, psc.slug, dsc.source_value_amount, dsc.applied_rate, dsc.amount, dsc.contract_signed_date_at_signing
    ORDER BY ${earnedRecognitionDateSql()} DESC, d.name ASC
  `);

  const monthRows = (monthResult as any).rows ?? monthResult;
  const dealRows = (dealsResult as any).rows ?? dealsResult;
  return {
    months: monthRows.map((row: any) => ({
      month: textFrom(row.month),
      earnedCommission: numberFrom(row.earned_commission),
      dealCount: numberFrom(row.deal_count),
    })),
    deals: dealRows.map((row: any) => ({
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
    })),
  };
}

export async function getCommissionSummary(
  tenantDb: TenantDb,
  filters: CommissionReportFilters
): Promise<CommissionSummary> {
  const result = await tenantDb.execute(sql`
    WITH earned AS (
      SELECT
        COALESCE(SUM(dsc.amount) FILTER (
          WHERE ${earnedRecognitionDateSql()} >= DATE_TRUNC('month', CURRENT_DATE)
        ), 0)::numeric AS earned_mtd,
        COALESCE(SUM(dsc.amount) FILTER (
          WHERE ${earnedRecognitionDateSql()} >= DATE_TRUNC('year', CURRENT_DATE)
        ), 0)::numeric AS earned_ytd
      FROM ${dealSignedCommissions} dsc
      JOIN ${deals} d ON d.id = dsc.deal_id
      JOIN ${pipelineStageConfig} psc ON psc.id = d.stage_id
      WHERE COALESCE(d.is_test_data, false) = false
        ${earnedStageSql()}
        ${commissionRepSql(filters)}
        ${dateSql(filters, "commission")}
        ${stageSql(filters)}
    ),
    potential AS (
      SELECT
        COALESCE(
          SUM(
            (COALESCE(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0) + COALESCE(d.change_order_total, 0))
            * COALESCE(cs.estimated_margin_rate, 0.30)
            * COALESCE(cs.commission_rate, 0)
          ),
          0
        )::numeric AS potential_pipeline
      FROM ${deals} d
      JOIN ${pipelineStageConfig} psc ON psc.id = d.stage_id
      LEFT JOIN ${userCommissionSettings} cs ON cs.user_id = d.assigned_rep_id AND cs.is_active = true
      WHERE d.is_active = true
        AND COALESCE(d.is_test_data, false) = false
        AND psc.is_terminal = false
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
      WHERE pe.paid_at >= DATE_TRUNC('year', CURRENT_DATE)
        AND COALESCE(d.is_test_data, false) = false
        ${repSql(filters)}
        ${stageSql(filters)}
    )
    SELECT earned.earned_mtd, earned.earned_ytd, potential.potential_pipeline, paid.paid_ytd
    FROM earned, potential, paid
  `);

  const rows = (result as any).rows ?? result;
  const row = rows[0] ?? {};
  return {
    earnedMtd: numberFrom(row.earned_mtd),
    earnedYtd: numberFrom(row.earned_ytd),
    potentialPipeline: numberFrom(row.potential_pipeline),
    paidYtd: numberFrom(row.paid_ytd),
  };
}
