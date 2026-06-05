import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import {
  aliasedActiveDealCountFilterSql,
  aliasedDealBestEstimateWithForecastSql,
  aliasedEffectiveDealValueSql,
  aliasedEffectiveWonDealValueSql,
  aliasedWonHsClosedWonDateSql,
} from "../shared/deal-value-sql.js";
import { LOST_STAGE_SLUGS, WON_STAGE_SLUGS } from "../shared/pipeline-terminal-stages.js";
// CC3 (Wave 0): hold-aware effective stage age (days) — on-hold time is not counted toward
// days-in-stage / the stuck threshold. Replaces raw NOW() - stage_entered_at.
import { aliasedEffectiveStageAgeDaysSql } from "../deals/deal-filter-predicates.js";

type TenantDb = NodePgDatabase<typeof schema>;
type ExecuteRows<T> = { rows: T[] } | T[];

const REPORT_CACHE_TTL_MS = 5 * 60 * 1000;
const TERMINAL_STAGE_SLUGS = [...WON_STAGE_SLUGS, ...LOST_STAGE_SLUGS] as const;

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

const reportCache = new Map<string, CacheEntry<unknown>>();

function rowsFromExecute<T>(result: ExecuteRows<T>): T[] {
  return Array.isArray(result) ? result : result.rows;
}

function round(value: number, decimals = 0) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function numberValue(value: number | string | null | undefined) {
  return Number(value ?? 0);
}

function dateOnly(value: Date) {
  return value.toISOString().slice(0, 10);
}

function defaultDateRange() {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 90);
  return { dateFrom: dateOnly(from), dateTo: dateOnly(to) };
}

export interface SalesReportFilters {
  dateFrom: string;
  dateTo: string;
  officeSlug?: string;
  ownerIds: string[];
  ownerNames: string[];
  ownerEmails: string[];
}

export function normalizeSalesReportFilters(input: Record<string, unknown> = {}): SalesReportFilters {
  const defaults = defaultDateRange();
  const rawDateFrom = typeof input.dateFrom === "string" ? input.dateFrom.trim() : "";
  const rawDateTo = typeof input.dateTo === "string" ? input.dateTo.trim() : "";
  const officeValue = typeof input.office === "string" ? input.office.trim() : "";
  const rawOwnerIds = Array.isArray(input.ownerIds)
    ? input.ownerIds.join(",")
    : typeof input.ownerIds === "string"
      ? input.ownerIds
      : "";
  const rawOwnerNames = Array.isArray(input.owners)
    ? input.owners.join(",")
    : typeof input.owners === "string"
      ? input.owners
      : "";
  const rawOwnerEmails = Array.isArray(input.ownerEmails)
    ? input.ownerEmails.join(",")
    : typeof input.ownerEmails === "string"
      ? input.ownerEmails
      : "";

  return {
    dateFrom: rawDateFrom || defaults.dateFrom,
    dateTo: rawDateTo || defaults.dateTo,
    officeSlug: officeValue && officeValue !== "all" ? officeValue : undefined,
    ownerIds: rawOwnerIds
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    ownerNames: rawOwnerNames
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    ownerEmails: rawOwnerEmails
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  };
}

function cacheKey(reportName: string, scopeKey: string, filters: SalesReportFilters) {
  return JSON.stringify({ reportName, scopeKey, filters });
}

async function withReportCache<T>(key: string, load: () => Promise<T>): Promise<T> {
  const cached = reportCache.get(key) as CacheEntry<T> | undefined;
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (cached) reportCache.delete(key);
  const value = await load();
  reportCache.set(key, { value, expiresAt: Date.now() + REPORT_CACHE_TTL_MS });
  return value;
}

function sqlStringList(values: readonly string[]) {
  return sql.join(values.map((value) => sql`${value}`), sql`, `);
}

// Assigned-rep only (NOT estimator-aware): buildOwnerIdentitySql feeds getClosedWonRevenueReport, which
// emits a per-rep rollup (PARTITION BY / GROUP BY assigned_rep_id) — an estimator-OR filter would
// misattribute an estimator-only person's deals to the owner's row. See the rep-keyed-report exclusion.
function buildOwnerIdentitySql(filters: Pick<SalesReportFilters, "ownerIds" | "ownerEmails" | "ownerNames">) {
  const clauses = [];
  if (filters.ownerIds.length > 0) clauses.push(sql`d.assigned_rep_id IN (${sqlStringList(filters.ownerIds)})`);
  if (filters.ownerEmails.length > 0) clauses.push(sql`LOWER(u.email) IN (${sqlStringList(filters.ownerEmails)})`);
  if (filters.ownerNames.length > 0) clauses.push(sql`u.display_name IN (${sqlStringList(filters.ownerNames)})`);
  if (clauses.length === 0) return null;
  return sql`(${sql.join(clauses, sql` OR `)})`;
}

function buildLeadOwnerIdentitySql(filters: Pick<SalesReportFilters, "ownerIds" | "ownerEmails" | "ownerNames">) {
  const clauses = [];
  if (filters.ownerIds.length > 0) clauses.push(sql`l.assigned_rep_id IN (${sqlStringList(filters.ownerIds)})`);
  if (filters.ownerEmails.length > 0) clauses.push(sql`LOWER(u.email) IN (${sqlStringList(filters.ownerEmails)})`);
  if (filters.ownerNames.length > 0) clauses.push(sql`u.display_name IN (${sqlStringList(filters.ownerNames)})`);
  if (clauses.length === 0) return null;
  return sql`(${sql.join(clauses, sql` OR `)})`;
}

export function terminalOutcomeDateSql() {
  // Terminal outcome date, split by outcome, each on its CANONICAL date so the win-rate compares deals
  // that reached an outcome in the same period:
  //   - WON arm: deals.won_closed_date (the protected 191 / $9,778,045.90 basis).
  //   - LOST arm: deals.lost_at (the canonical lost date, set when the deal enters a Lost stage), with a
  //     COALESCE fallback to the legacy actual_close_date / stage_entered_at ONLY for older lost deals
  //     whose lost_at was never stamped (so none silently disappear from the denominator). This is the
  //     Lost-unification pass (PR-E): the old LOST arm windowed on reseed-contaminated actual_close_date
  //     (and stage_entered_at, not a close date at all), skewing the win-rate denominator vs the
  //     canonical WON numerator.
  return sql`
    CASE
      WHEN p.slug IN (${sqlStringList(LOST_STAGE_SLUGS)})
        THEN COALESCE(d.lost_at, d.actual_close_date::timestamptz, d.stage_entered_at)
      ELSE ${aliasedWonHsClosedWonDateSql("d")}::timestamptz
    END
  `;
}

function buildDealFilterSql(filters: SalesReportFilters, dateField?: "created_at" | "won_at") {
  const clauses = [
    sql`d.is_active = true`,
    sql`COALESCE(d.is_test_data, false) = false`,
  ];
  if (dateField === "created_at") {
    clauses.push(sql`d.created_at >= ${filters.dateFrom}::date`);
    clauses.push(sql`d.created_at < (${filters.dateTo}::date + INTERVAL '1 day')`);
  }
  if (dateField === "won_at") {
    const outcomeDate = terminalOutcomeDateSql();
    clauses.push(sql`${outcomeDate} >= ${filters.dateFrom}::date`);
    clauses.push(sql`${outcomeDate} < (${filters.dateTo}::date + INTERVAL '1 day')`);
  }
  if (filters.officeSlug) {
    clauses.push(sql`(u.office_id IN (SELECT id FROM offices WHERE slug = ${filters.officeSlug}) OR LOWER(COALESCE(d.office_code, '')) = LOWER(${filters.officeSlug}))`);
  }
  const ownerIdentity = buildOwnerIdentitySql(filters);
  if (ownerIdentity) clauses.push(ownerIdentity);
  return sql.join(clauses, sql` AND `);
}

function buildLeadFilterSql(filters: SalesReportFilters) {
  const clauses = [
    sql`l.is_active = true`,
    sql`COALESCE(l.is_test_data, false) = false`,
    sql`l.created_at >= ${filters.dateFrom}::date`,
    sql`l.created_at < (${filters.dateTo}::date + INTERVAL '1 day')`,
  ];
  if (filters.officeSlug) {
    clauses.push(sql`(u.office_id IN (SELECT id FROM offices WHERE slug = ${filters.officeSlug}) OR LOWER(COALESCE(l.office_code, '')) = LOWER(${filters.officeSlug}))`);
  }
  const ownerIdentity = buildLeadOwnerIdentitySql(filters);
  if (ownerIdentity) clauses.push(ownerIdentity);
  return sql.join(clauses, sql` AND `);
}

export interface PipelineVelocityStageRow extends Record<string, unknown> {
  stageId: string;
  stageName: string;
  stageOrder: number;
  openDeals: number | string;
  totalValue: number | string | null;
  avgDaysInStage: number | string | null;
  medianDaysInStage: number | string | null;
  oldestDealId: string | null;
  oldestDealName: string | null;
  oldestDealDays: number | string | null;
}

export interface PipelineVelocityAgingRow extends Record<string, unknown> {
  bucket: string;
  dealCount: number | string;
  totalValue: number | string | null;
}

export interface PipelineVelocityStuckRow extends Record<string, unknown> {
  dealId: string;
  dealName: string;
  ownerName: string;
  stageName: string;
  daysInStage: number | string;
  value: number | string | null;
}

export interface PipelineVelocityOverview {
  kpis: {
    avgDealAgeDays: number;
    totalOpenValue: number;
    openDealCount: number;
    stuckDealCount: number;
  };
  stages: Array<{
    stageId: string;
    stageName: string;
    openDeals: number;
    totalValue: number;
    avgDaysInStage: number;
    medianDaysInStage: number;
    oldestDeal: { dealId: string | null; dealName: string; daysInStage: number };
  }>;
  agingBuckets: Array<{ bucket: string; label: string; dealCount: number; totalValue: number }>;
  stuckDeals: Array<{
    dealId: string;
    dealName: string;
    ownerName: string;
    stageName: string;
    daysInStage: number;
    value: number;
  }>;
}

const AGING_LABELS: Record<string, string> = {
  "0-7": "0-7 days",
  "8-30": "8-30 days",
  "31-60": "31-60 days",
  "60+": "60+ days",
};

export function buildPipelineVelocityOverviewFromRows(input: {
  stageRows: PipelineVelocityStageRow[];
  agingRows: PipelineVelocityAgingRow[];
  stuckRows: PipelineVelocityStuckRow[];
}): PipelineVelocityOverview {
  const stages = input.stageRows
    .slice()
    .sort((a, b) => Number(a.stageOrder) - Number(b.stageOrder))
    .map((row) => ({
      stageId: row.stageId,
      stageName: row.stageName || "Unassigned Stage",
      openDeals: numberValue(row.openDeals),
      totalValue: numberValue(row.totalValue),
      avgDaysInStage: round(numberValue(row.avgDaysInStage)),
      medianDaysInStage: round(numberValue(row.medianDaysInStage)),
      oldestDeal: {
        dealId: row.oldestDealId,
        dealName: row.oldestDealName || "No open deal",
        daysInStage: round(numberValue(row.oldestDealDays)),
      },
    }));

  const openDealCount = stages.reduce((sum, row) => sum + row.openDeals, 0);
  const totalOpenValue = stages.reduce((sum, row) => sum + row.totalValue, 0);
  const weightedAge = stages.reduce((sum, row) => sum + row.avgDaysInStage * row.openDeals, 0);
  const stuckDeals = input.stuckRows.map((row) => ({
    dealId: row.dealId,
    dealName: row.dealName,
    ownerName: row.ownerName || "Unassigned",
    stageName: row.stageName || "Unassigned Stage",
    daysInStage: round(numberValue(row.daysInStage)),
    value: numberValue(row.value),
  }));

  return {
    kpis: {
      avgDealAgeDays: openDealCount ? round(weightedAge / openDealCount) : 0,
      totalOpenValue,
      openDealCount,
      stuckDealCount: stuckDeals.length,
    },
    stages,
    agingBuckets: input.agingRows.map((row) => ({
      bucket: row.bucket,
      label: AGING_LABELS[row.bucket] ?? row.bucket,
      dealCount: numberValue(row.dealCount),
      totalValue: numberValue(row.totalValue),
    })),
    stuckDeals,
  };
}

export interface ClosedWonRevenueOverview {
  kpis: { totalBookedRevenue: number; wonDealCount: number; avgDealSize: number; winRate: number };
  monthlyRevenue: Array<{ month: string; label: string; totalRevenue: number; wonDeals: number }>;
  byOwner: Array<{
    ownerId: string;
    ownerName: string;
    wonDeals: number;
    totalRevenue: number;
    avgDealSize: number;
    largestWonDeal: { dealId: string | null; dealName: string; value: number };
  }>;
  byRegion: Array<{ regionName: string; wonDeals: number; totalRevenue: number; percentOfTotal: number }>;
  byWorkflowFamily: Array<{ workflowFamily: string; workflowFamilyName: string; wonDeals: number; totalRevenue: number }>;
  topDeals: Array<{ dealId: string; dealName: string; ownerName: string; value: number; wonAt: string }>;
}

function monthLabel(month: string) {
  const [year, monthPart] = month.split("-");
  return new Date(Number(year), Number(monthPart) - 1, 1).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function workflowFamilyName(value: string) {
  if (value === "service_deal" || value === "service") return "Service Deal";
  return "Standard Deal";
}

export function buildClosedWonRevenueOverviewFromRows(input: {
  summaryRows: Array<{ wonDeals: number | string; lostDeals: number | string; totalRevenue: number | string | null }>;
  ownerRows: Array<{
    ownerId: string;
    ownerName: string;
    wonDeals: number | string;
    totalRevenue: number | string | null;
    largestWonDealId: string | null;
    largestWonDealName: string | null;
    largestWonDealValue: number | string | null;
  }>;
  regionRows: Array<{ regionName: string; wonDeals: number | string; totalRevenue: number | string | null }>;
  workflowRows: Array<{ workflowFamily: string; wonDeals: number | string; totalRevenue: number | string | null }>;
  monthlyRows: Array<{ month: string; totalRevenue: number | string | null; wonDeals: number | string }>;
  topDeals: Array<{ dealId: string; dealName: string; ownerName: string; value: number | string | null; wonAt: string }>;
}): ClosedWonRevenueOverview {
  const summary = input.summaryRows[0] ?? { wonDeals: 0, lostDeals: 0, totalRevenue: 0 };
  const wonDealCount = numberValue(summary.wonDeals);
  const lostDeals = numberValue(summary.lostDeals);
  const totalBookedRevenue = numberValue(summary.totalRevenue);

  return {
    kpis: {
      totalBookedRevenue,
      wonDealCount,
      avgDealSize: wonDealCount ? round(totalBookedRevenue / wonDealCount) : 0,
      winRate: wonDealCount + lostDeals ? round((wonDealCount / (wonDealCount + lostDeals)) * 100, 1) : 0,
    },
    monthlyRevenue: input.monthlyRows.map((row) => ({
      month: row.month,
      label: monthLabel(row.month),
      totalRevenue: numberValue(row.totalRevenue),
      wonDeals: numberValue(row.wonDeals),
    })),
    byOwner: input.ownerRows.map((row) => {
      const wonDeals = numberValue(row.wonDeals);
      const totalRevenue = numberValue(row.totalRevenue);
      return {
        ownerId: row.ownerId,
        ownerName: row.ownerName || "Unassigned",
        wonDeals,
        totalRevenue,
        avgDealSize: wonDeals ? round(totalRevenue / wonDeals) : 0,
        largestWonDeal: {
          dealId: row.largestWonDealId,
          dealName: row.largestWonDealName || "No won deal",
          value: numberValue(row.largestWonDealValue),
        },
      };
    }),
    byRegion: input.regionRows.map((row) => {
      const wonDeals = numberValue(row.wonDeals);
      const totalRevenue = numberValue(row.totalRevenue);
      return {
        regionName: row.regionName || "Unassigned Region",
        wonDeals,
        totalRevenue,
        percentOfTotal: totalBookedRevenue ? round((totalRevenue / totalBookedRevenue) * 100, 1) : 0,
      };
    }),
    byWorkflowFamily: input.workflowRows.map((row) => ({
      workflowFamily: row.workflowFamily,
      workflowFamilyName: workflowFamilyName(row.workflowFamily),
      wonDeals: numberValue(row.wonDeals),
      totalRevenue: numberValue(row.totalRevenue),
    })),
    topDeals: input.topDeals.map((row) => ({
      dealId: row.dealId,
      dealName: row.dealName,
      ownerName: row.ownerName || "Unassigned",
      value: numberValue(row.value),
      wonAt: row.wonAt,
    })),
  };
}

export interface LeadConversionOverview {
  kpis: { totalLeads: number; qualified: number; inDeals: number; won: number; leadToDealRate: number; dealToWonRate: number };
  funnel: Array<{ key: string; label: string; count: number; conversionRate: number }>;
  bySource: Array<{ source: string; leads: number; qualified: number; convertedToDeal: number; won: number; totalRevenue: number }>;
  monthlyTrend: Array<{ month: string; label: string; leads: number; convertedToDeal: number; won: number; conversionRate: number }>;
  topRevenueSources: Array<{ source: string; totalRevenue: number; won: number }>;
}

export function buildLeadConversionOverviewFromRows(input: {
  summaryRows: Array<{ totalLeads: number | string; qualified: number | string; inDeals: number | string; won: number | string }>;
  sourceRows: Array<{ source: string | null; leads: number | string; qualified: number | string; convertedToDeal: number | string; won: number | string; totalRevenue: number | string | null }>;
  monthlyRows: Array<{ month: string; leads: number | string; convertedToDeal: number | string; won: number | string }>;
  revenueRows: Array<{ source: string | null; totalRevenue: number | string | null; won: number | string }>;
}): LeadConversionOverview {
  const summary = input.summaryRows[0] ?? { totalLeads: 0, qualified: 0, inDeals: 0, won: 0 };
  const totalLeads = numberValue(summary.totalLeads);
  const qualified = numberValue(summary.qualified);
  const inDeals = numberValue(summary.inDeals);
  const won = numberValue(summary.won);

  return {
    kpis: {
      totalLeads,
      qualified,
      inDeals,
      won,
      leadToDealRate: totalLeads ? round((inDeals / totalLeads) * 100, 1) : 0,
      dealToWonRate: inDeals ? round((won / inDeals) * 100, 1) : 0,
    },
    funnel: [
      { key: "leads", label: "Leads", count: totalLeads, conversionRate: 100 },
      { key: "qualified", label: "Qualified", count: qualified, conversionRate: totalLeads ? round((qualified / totalLeads) * 100, 1) : 0 },
      { key: "inDeals", label: "In Deal", count: inDeals, conversionRate: qualified ? round((inDeals / qualified) * 100, 1) : 0 },
      { key: "won", label: "Won", count: won, conversionRate: inDeals ? round((won / inDeals) * 100, 1) : 0 },
    ],
    bySource: input.sourceRows.map((row) => ({
      source: row.source || "Unknown",
      leads: numberValue(row.leads),
      qualified: numberValue(row.qualified),
      convertedToDeal: numberValue(row.convertedToDeal),
      won: numberValue(row.won),
      totalRevenue: numberValue(row.totalRevenue),
    })),
    monthlyTrend: input.monthlyRows.map((row) => {
      const leads = numberValue(row.leads);
      const convertedToDeal = numberValue(row.convertedToDeal);
      return {
        month: row.month,
        label: monthLabel(row.month),
        leads,
        convertedToDeal,
        won: numberValue(row.won),
        conversionRate: leads ? round((convertedToDeal / leads) * 100, 1) : 0,
      };
    }),
    topRevenueSources: input.revenueRows.map((row) => ({
      source: row.source || "Unknown",
      totalRevenue: numberValue(row.totalRevenue),
      won: numberValue(row.won),
    })),
  };
}

export async function getPipelineVelocityReport(
  tenantDb: TenantDb,
  filters: SalesReportFilters,
  scopeKey = "default"
): Promise<PipelineVelocityOverview> {
  return withReportCache(cacheKey("pipeline-velocity", scopeKey, filters), async () => {
    // CURRENT open inventory — NOT windowed on created_at (PR-D). Velocity is a snapshot of the pipeline
    // aged by stage; a deal created before the selected range but still open today belongs in the
    // stage-aging / stuck views. Windowing on created_at silently dropped old-but-stuck inventory.
    // (The date range does not apply to this report; the page shows a caption to that effect.)
    const whereSql = buildDealFilterSql(filters);
    const terminalSlugs = sqlStringList(TERMINAL_STAGE_SLUGS);

    const stageRows = rowsFromExecute<PipelineVelocityStageRow>(await tenantDb.execute<PipelineVelocityStageRow>(sql`
      WITH open_deals AS (
        SELECT
          d.id,
          d.name,
          d.stage_id,
          d.on_hold,
          ${aliasedEffectiveDealValueSql("d", aliasedDealBestEstimateWithForecastSql("d"))} AS value,
          ${aliasedEffectiveStageAgeDaysSql("d")}::int AS days_in_stage,
          p.name AS stage_name,
          p.display_order AS stage_order
        FROM deals d
        JOIN pipeline_stage_config p ON p.id = d.stage_id
        LEFT JOIN users u ON u.id = d.assigned_rep_id
        WHERE ${whereSql}
          AND p.slug NOT IN (${terminalSlugs})
      ),
      ranked AS (
        SELECT
          *,
          ROW_NUMBER() OVER (
            PARTITION BY stage_id
            ORDER BY
              CASE WHEN ${aliasedActiveDealCountFilterSql("open_deals")} THEN 0 ELSE 1 END,
              days_in_stage DESC,
              name ASC
          ) AS rn
        FROM open_deals
      )
      SELECT
        stage_id AS "stageId",
        MAX(stage_name) AS "stageName",
        MAX(stage_order) AS "stageOrder",
        COUNT(*) FILTER (WHERE ${aliasedActiveDealCountFilterSql("ranked")})::int AS "openDeals",
        COALESCE(SUM(value), 0)::numeric AS "totalValue",
        COALESCE(AVG(days_in_stage) FILTER (WHERE ${aliasedActiveDealCountFilterSql("ranked")}), 0)::numeric AS "avgDaysInStage",
        COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY days_in_stage) FILTER (WHERE ${aliasedActiveDealCountFilterSql("ranked")}), 0)::numeric AS "medianDaysInStage",
        (array_agg(id::text) FILTER (WHERE rn = 1 AND ${aliasedActiveDealCountFilterSql("ranked")}))[1] AS "oldestDealId",
        (array_agg(name) FILTER (WHERE rn = 1 AND ${aliasedActiveDealCountFilterSql("ranked")}))[1] AS "oldestDealName",
        ((array_agg(days_in_stage) FILTER (WHERE rn = 1 AND ${aliasedActiveDealCountFilterSql("ranked")}))[1])::int AS "oldestDealDays"
      FROM ranked
      GROUP BY stage_id
      ORDER BY MAX(stage_order), MAX(stage_name)
    `));

    const agingRows = rowsFromExecute<PipelineVelocityAgingRow>(await tenantDb.execute<PipelineVelocityAgingRow>(sql`
      WITH open_deals AS (
        SELECT
          d.on_hold,
          ${aliasedEffectiveDealValueSql("d", aliasedDealBestEstimateWithForecastSql("d"))} AS value,
          ${aliasedEffectiveStageAgeDaysSql("d")}::int AS days_in_stage
        FROM deals d
        JOIN pipeline_stage_config p ON p.id = d.stage_id
        LEFT JOIN users u ON u.id = d.assigned_rep_id
        WHERE ${whereSql}
          AND p.slug NOT IN (${terminalSlugs})
      )
      SELECT
        CASE
          WHEN days_in_stage <= 7 THEN '0-7'
          WHEN days_in_stage <= 30 THEN '8-30'
          WHEN days_in_stage <= 60 THEN '31-60'
          ELSE '60+'
        END AS bucket,
        COUNT(*) FILTER (WHERE ${aliasedActiveDealCountFilterSql("open_deals")})::int AS "dealCount",
        COALESCE(SUM(value), 0)::numeric AS "totalValue"
      FROM open_deals
      GROUP BY bucket
      ORDER BY MIN(days_in_stage)
    `));

    const stuckRows = rowsFromExecute<PipelineVelocityStuckRow>(await tenantDb.execute<PipelineVelocityStuckRow>(sql`
      SELECT
        d.id::text AS "dealId",
        d.name AS "dealName",
        COALESCE(u.display_name, 'Unassigned') AS "ownerName",
        p.name AS "stageName",
        ${aliasedEffectiveStageAgeDaysSql("d")}::int AS "daysInStage",
        ${aliasedEffectiveDealValueSql("d", aliasedDealBestEstimateWithForecastSql("d"))} AS value
      FROM deals d
      JOIN pipeline_stage_config p ON p.id = d.stage_id
      LEFT JOIN users u ON u.id = d.assigned_rep_id
      WHERE ${whereSql}
        AND p.slug NOT IN (${terminalSlugs})
        AND ${aliasedEffectiveStageAgeDaysSql("d")} > 30
        AND ${aliasedActiveDealCountFilterSql("d")}
      ORDER BY "daysInStage" DESC, value DESC
      LIMIT 10
    `));

    return buildPipelineVelocityOverviewFromRows({ stageRows, agingRows, stuckRows });
  });
}

export async function getClosedWonRevenueReport(
  tenantDb: TenantDb,
  filters: SalesReportFilters,
  scopeKey = "default"
): Promise<ClosedWonRevenueOverview> {
  return withReportCache(cacheKey("closed-won-revenue", scopeKey, filters), async () => {
    const whereSql = buildDealFilterSql(filters, "won_at");
    const wonSlugs = sqlStringList(WON_STAGE_SLUGS);
    const lostSlugs = sqlStringList(LOST_STAGE_SLUGS);
    const outcomeDate = terminalOutcomeDateSql();

    const summaryRows = rowsFromExecute<{ wonDeals: number | string; lostDeals: number | string; totalRevenue: number | string | null }>(await tenantDb.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE p.slug IN (${wonSlugs}) AND ${aliasedActiveDealCountFilterSql("d")})::int AS "wonDeals",
        COUNT(*) FILTER (WHERE p.slug IN (${lostSlugs}) AND ${aliasedActiveDealCountFilterSql("d")})::int AS "lostDeals",
        COALESCE(SUM(${aliasedEffectiveWonDealValueSql("d")}) FILTER (WHERE p.slug IN (${wonSlugs})), 0)::numeric AS "totalRevenue"
      FROM deals d
      JOIN pipeline_stage_config p ON p.id = d.stage_id
      LEFT JOIN users u ON u.id = d.assigned_rep_id
      WHERE ${whereSql}
        AND p.slug IN (${sqlStringList(TERMINAL_STAGE_SLUGS)})
    `));

    const ownerRows = rowsFromExecute<any>(await tenantDb.execute(sql`
      WITH won_deals AS (
        SELECT
          d.id,
          d.name,
          d.assigned_rep_id,
          COALESCE(u.display_name, 'Unassigned') AS owner_name,
          ${aliasedEffectiveWonDealValueSql("d")} AS value,
          ROW_NUMBER() OVER (PARTITION BY d.assigned_rep_id ORDER BY ${aliasedEffectiveWonDealValueSql("d")} DESC, d.name ASC) AS rn
        FROM deals d
        JOIN pipeline_stage_config p ON p.id = d.stage_id
        LEFT JOIN users u ON u.id = d.assigned_rep_id
        WHERE ${whereSql}
          AND p.slug IN (${wonSlugs})
          AND ${aliasedActiveDealCountFilterSql("d")}
      )
      SELECT
        COALESCE(assigned_rep_id::text, 'unassigned') AS "ownerId",
        MAX(owner_name) AS "ownerName",
        COUNT(*)::int AS "wonDeals",
        COALESCE(SUM(value), 0)::numeric AS "totalRevenue",
        (array_agg(id::text) FILTER (WHERE rn = 1))[1] AS "largestWonDealId",
        (array_agg(name) FILTER (WHERE rn = 1))[1] AS "largestWonDealName",
        ((array_agg(value) FILTER (WHERE rn = 1))[1])::numeric AS "largestWonDealValue"
      FROM won_deals
      GROUP BY assigned_rep_id
      ORDER BY "totalRevenue" DESC
    `));

    // By REGION (region_classification, then property city/state), grouped on the single region
    // expression so one region = one row — a single office no longer fragments into multiple rows the
    // way the old byOffice GROUP BY (o.id, o.name, d.office_code) did.
    const regionRows = rowsFromExecute<any>(await tenantDb.execute(sql`
      SELECT
        COALESCE(
          NULLIF(TRIM(d.region_classification), ''),
          -- Normalize each component (NULLIF(TRIM(..),'')) BEFORE concatenating: CONCAT_WS skips NULLs
          -- but NOT empty strings, so a blank city/state would otherwise leak ", TX" / "Dallas, " labels.
          NULLIF(TRIM(CONCAT_WS(', ', NULLIF(TRIM(d.property_city), ''), NULLIF(TRIM(d.property_state), ''))), ''),
          'Unassigned Region'
        ) AS "regionName",
        COUNT(*)::int AS "wonDeals",
        COALESCE(SUM(${aliasedEffectiveWonDealValueSql("d")}), 0)::numeric AS "totalRevenue"
      FROM deals d
      JOIN pipeline_stage_config p ON p.id = d.stage_id
      LEFT JOIN users u ON u.id = d.assigned_rep_id
      WHERE ${whereSql}
        AND p.slug IN (${wonSlugs})
        AND ${aliasedActiveDealCountFilterSql("d")}
      GROUP BY 1
      ORDER BY "totalRevenue" DESC
    `));

    const workflowRows = rowsFromExecute<any>(await tenantDb.execute(sql`
      SELECT
        CASE WHEN d.workflow_route = 'service' THEN 'service_deal' ELSE 'standard_deal' END AS "workflowFamily",
        COUNT(*)::int AS "wonDeals",
        COALESCE(SUM(${aliasedEffectiveWonDealValueSql("d")}), 0)::numeric AS "totalRevenue"
      FROM deals d
      JOIN pipeline_stage_config p ON p.id = d.stage_id
      LEFT JOIN users u ON u.id = d.assigned_rep_id
      WHERE ${whereSql}
        AND p.slug IN (${wonSlugs})
        AND ${aliasedActiveDealCountFilterSql("d")}
      GROUP BY "workflowFamily"
      ORDER BY "totalRevenue" DESC
    `));

    const monthlyRows = rowsFromExecute<any>(await tenantDb.execute(sql`
      SELECT
        TO_CHAR(DATE_TRUNC('month', ${outcomeDate}), 'YYYY-MM') AS month,
        COALESCE(SUM(${aliasedEffectiveWonDealValueSql("d")}), 0)::numeric AS "totalRevenue",
        COUNT(*)::int AS "wonDeals"
      FROM deals d
      JOIN pipeline_stage_config p ON p.id = d.stage_id
      LEFT JOIN users u ON u.id = d.assigned_rep_id
      WHERE ${whereSql}
        AND p.slug IN (${wonSlugs})
        AND ${aliasedActiveDealCountFilterSql("d")}
      GROUP BY month
      ORDER BY month
    `));

    const topDeals = rowsFromExecute<any>(await tenantDb.execute(sql`
      SELECT
        d.id::text AS "dealId",
        d.name AS "dealName",
        COALESCE(u.display_name, 'Unassigned') AS "ownerName",
        ${aliasedEffectiveWonDealValueSql("d")} AS value,
        ${aliasedWonHsClosedWonDateSql("d")}::date::text AS "wonAt"
      FROM deals d
      JOIN pipeline_stage_config p ON p.id = d.stage_id
      LEFT JOIN users u ON u.id = d.assigned_rep_id
      WHERE ${whereSql}
        AND p.slug IN (${wonSlugs})
        AND ${aliasedActiveDealCountFilterSql("d")}
      ORDER BY value DESC, "wonAt" DESC
      LIMIT 10
    `));

    return buildClosedWonRevenueOverviewFromRows({ summaryRows, ownerRows, regionRows, workflowRows, monthlyRows, topDeals });
  });
}

export async function getLeadConversionReport(
  tenantDb: TenantDb,
  filters: SalesReportFilters,
  scopeKey = "default"
): Promise<LeadConversionOverview> {
  return withReportCache(cacheKey("lead-conversion", scopeKey, filters), async () => {
    const leadWhereSql = buildLeadFilterSql(filters);
    const wonSlugs = sqlStringList(WON_STAGE_SLUGS);

    const summaryRows = rowsFromExecute<any>(await tenantDb.execute(sql`
      SELECT
        COUNT(DISTINCT l.id)::int AS "totalLeads",
        COUNT(DISTINCT l.id) FILTER (
          WHERE l.converted_at IS NOT NULL
             OR l.qualification_completed_at IS NOT NULL
             OR l.status = 'converted'
        )::int AS qualified,
        COUNT(DISTINCT d.id)::int AS "inDeals",
        COUNT(DISTINCT d.id) FILTER (WHERE p.slug IN (${wonSlugs}) AND ${aliasedActiveDealCountFilterSql("d")})::int AS won
      FROM leads l
      LEFT JOIN users u ON u.id = l.assigned_rep_id
      LEFT JOIN deals d ON d.source_lead_id = l.id
        AND d.is_active = true
        AND COALESCE(d.is_test_data, false) = false
        AND ${aliasedActiveDealCountFilterSql("d")}
      LEFT JOIN pipeline_stage_config p ON p.id = d.stage_id
      WHERE ${leadWhereSql}
    `));

    const sourceRows = rowsFromExecute<any>(await tenantDb.execute(sql`
      SELECT
        COALESCE(l.source, l.source_category::text, 'Unknown') AS source,
        COUNT(DISTINCT l.id)::int AS leads,
        COUNT(DISTINCT l.id) FILTER (
          WHERE l.converted_at IS NOT NULL
             OR l.qualification_completed_at IS NOT NULL
             OR l.status = 'converted'
        )::int AS qualified,
        COUNT(DISTINCT d.id)::int AS "convertedToDeal",
        COUNT(DISTINCT d.id) FILTER (WHERE p.slug IN (${wonSlugs}) AND ${aliasedActiveDealCountFilterSql("d")})::int AS won,
        COALESCE(SUM(${aliasedEffectiveWonDealValueSql("d")}) FILTER (WHERE p.slug IN (${wonSlugs})), 0)::numeric AS "totalRevenue"
      FROM leads l
      LEFT JOIN users u ON u.id = l.assigned_rep_id
      LEFT JOIN deals d ON d.source_lead_id = l.id
        AND d.is_active = true
        AND COALESCE(d.is_test_data, false) = false
        AND ${aliasedActiveDealCountFilterSql("d")}
      LEFT JOIN pipeline_stage_config p ON p.id = d.stage_id
      WHERE ${leadWhereSql}
      GROUP BY 1
      ORDER BY "totalRevenue" DESC, leads DESC
    `));

    const monthlyRows = rowsFromExecute<any>(await tenantDb.execute(sql`
      SELECT
        TO_CHAR(DATE_TRUNC('month', l.created_at), 'YYYY-MM') AS month,
        COUNT(DISTINCT l.id)::int AS leads,
        COUNT(DISTINCT d.id)::int AS "convertedToDeal",
        COUNT(DISTINCT d.id) FILTER (WHERE p.slug IN (${wonSlugs}) AND ${aliasedActiveDealCountFilterSql("d")})::int AS won
      FROM leads l
      LEFT JOIN users u ON u.id = l.assigned_rep_id
      LEFT JOIN deals d ON d.source_lead_id = l.id
        AND d.is_active = true
        AND COALESCE(d.is_test_data, false) = false
        AND ${aliasedActiveDealCountFilterSql("d")}
      LEFT JOIN pipeline_stage_config p ON p.id = d.stage_id
      WHERE ${leadWhereSql}
      GROUP BY month
      ORDER BY month DESC
      LIMIT 6
    `)).reverse();

    const revenueRows = rowsFromExecute<any>(await tenantDb.execute(sql`
      SELECT
        COALESCE(l.source, l.source_category::text, 'Unknown') AS source,
        COALESCE(SUM(${aliasedEffectiveWonDealValueSql("d")}) FILTER (WHERE p.slug IN (${wonSlugs})), 0)::numeric AS "totalRevenue",
        COUNT(DISTINCT d.id) FILTER (WHERE p.slug IN (${wonSlugs}) AND ${aliasedActiveDealCountFilterSql("d")})::int AS won
      FROM leads l
      LEFT JOIN users u ON u.id = l.assigned_rep_id
      LEFT JOIN deals d ON d.source_lead_id = l.id
        AND d.is_active = true
        AND COALESCE(d.is_test_data, false) = false
        AND ${aliasedActiveDealCountFilterSql("d")}
      LEFT JOIN pipeline_stage_config p ON p.id = d.stage_id
      WHERE ${leadWhereSql}
      GROUP BY 1
      ORDER BY "totalRevenue" DESC
      LIMIT 5
    `));

    return buildLeadConversionOverviewFromRows({ summaryRows, sourceRows, monthlyRows, revenueRows });
  });
}
