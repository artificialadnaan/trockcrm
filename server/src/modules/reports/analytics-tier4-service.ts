import { sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";

type TenantDb = NodePgDatabase<typeof schema>;
type ExecuteRows<T> = { rows: T[] } | T[];

const CACHE_TTL_MS = 5 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WON_STAGE_SLUGS = ["won", "sent_to_production", "service_sent_to_production", "closed_won"];
const LOST_STAGE_SLUGS = ["lost", "production_lost", "service_lost", "closed_lost"];

const cacheByTenantDb = new WeakMap<object, Map<string, { expiresAt: number; value: unknown }>>();

export interface AnalyticsTier4Filters {
  from?: string;
  to?: string;
  office?: string;
  ownerIds?: string[];
  ownerNames?: string[];
}

export interface MarketMixReport {
  kpis: {
    totalDealCount: number;
    totalWonValue: number;
    activeMarkets: number;
    mostActiveRegion: string;
  };
  verticalMix: Array<{ name: string; dealCount: number; wonValue: number }>;
  propertyTypeMix: Array<{ name: string; dealCount: number; wonValue: number }>;
  regionMix: Array<{ name: string; dealCount: number; wonValue: number }>;
  quarterlyWonByVertical: Array<{ quarter: string; vertical: string; wonValue: number }>;
  breakdown: Array<{
    vertical: string;
    activeDeals: number;
    wonLastYear: number;
    winRate: number;
    avgDealSize: number;
  }>;
  proxyNotes: string[];
}

export interface CustomerConcentrationReport {
  kpis: {
    totalActiveCustomers: number;
    totalOpenValue: number;
    topCustomerPipelinePercent: number;
    customersOverOneMillionOpen: number;
  };
  scopeNote: string;
  topCustomers: Array<{
    companyId: string;
    companyName: string;
    activeDeals: number;
    totalOpenValue: number;
    totalWonLifetime: number;
    lastActivityAt: string | null;
    accountOwners: string;
  }>;
  pareto: Array<{
    rank: number;
    companyId: string;
    companyName: string;
    pipelineValue: number;
    cumulativePipelinePercent: number;
  }>;
  distribution: Array<{ bucket: string; customerCount: number }>;
  staleCustomers: Array<{
    companyName: string;
    ownerName: string;
    openDeals: number;
    openValue: number;
    daysStale: number;
  }>;
}

export interface ExecutiveTrendsReport {
  kpis: Array<{
    label: string;
    value: number;
    changePercent: number;
    direction: "up" | "down" | "flat";
    format: "currency" | "number" | "percent";
  }>;
  monthlyTrends: Array<{
    month: string;
    newDeals: number;
    wonDeals: number;
    lostDeals: number;
    activePipelineValue: number;
  }>;
  activePipelineNote: string;
  quarterlyComparison: Array<{
    quarter: string;
    dealsCreated: number;
    won: number;
    lost: number;
    winRate: number;
    avgDealSize: number;
    pipelineEndValue: number;
  }>;
  winRateTrend: Array<{ month: string; winRate: number }>;
  stageProgression: Array<{
    stageName: string;
    enteredCount: number;
    advancedCount: number;
    progressionRate: number;
  }>;
}

function rowsFromExecute<T>(result: ExecuteRows<T>): T[] {
  return Array.isArray(result) ? result : result.rows;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function defaultFromIso() {
  const date = new Date();
  date.setUTCMonth(date.getUTCMonth() - 12);
  return date.toISOString().slice(0, 10);
}

function normalizeFilters(filters: AnalyticsTier4Filters = {}) {
  return {
    from: filters.from ?? defaultFromIso(),
    to: filters.to ?? todayIso(),
    office: filters.office && filters.office !== "all" ? filters.office : undefined,
    ownerIds: Array.from(new Set((filters.ownerIds ?? []).map((id) => id.trim()).filter(Boolean))),
    ownerNames: Array.from(new Set((filters.ownerNames ?? []).map((name) => name.trim()).filter(Boolean))),
  };
}

function sqlStringList(values: readonly string[]) {
  return sql.join(values.map((value) => sql`${value}`), sql`, `);
}

function buildWhere(filters: ReturnType<typeof normalizeFilters>, dateColumn: SQL = sql`d.created_at`) {
  return sql`
    ${buildScopeWhere(filters)}
    AND ${dateColumn} >= ${filters.from}::timestamptz
    AND ${dateColumn} < (${filters.to}::date + INTERVAL '1 day')::timestamptz
  `;
}

function buildScopeWhere(filters: ReturnType<typeof normalizeFilters>) {
  const ownerFilter = filters.ownerIds.length
    ? sql`AND d.assigned_rep_id IN (${sql.join(filters.ownerIds.map((id) => sql`${id}::uuid`), sql`, `)})`
    : filters.ownerNames.length
      ? sql`AND u.display_name IN (${sqlStringList(filters.ownerNames)})`
    : sql``;
  const officeFilter = filters.office
    ? UUID_PATTERN.test(filters.office)
      ? sql`AND (
          u.office_id = ${filters.office}::uuid
          OR EXISTS (
            SELECT 1
            FROM offices office_scope
            WHERE office_scope.id = ${filters.office}::uuid
              AND (
                LOWER(COALESCE(d.office_code, '')) = LOWER(office_scope.slug)
                OR LOWER(COALESCE(d.office_code, '')) = LOWER(office_scope.name)
                OR COALESCE(d.office_code, '') = office_scope.id::text
              )
          )
        )`
      : sql`AND LOWER(COALESCE(d.office_code, '')) = LOWER(${filters.office})`
    : sql``;

  return sql`
    COALESCE(d.is_test_data, false) = false
    ${ownerFilter}
    ${officeFilter}
  `;
}

async function cached<T>(tenantDb: TenantDb, key: string, loader: () => Promise<T>): Promise<T> {
  const now = Date.now();
  let tenantCache = cacheByTenantDb.get(tenantDb as object);
  if (!tenantCache) {
    tenantCache = new Map();
    cacheByTenantDb.set(tenantDb as object, tenantCache);
  }

  const cachedValue = tenantCache.get(key);
  if (cachedValue && cachedValue.expiresAt > now) return cachedValue.value as T;

  const value = await loader();
  tenantCache.set(key, { expiresAt: now + CACHE_TTL_MS, value });
  return value;
}

function numberFrom(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round1(value: number) {
  return Math.round(value * 10) / 10;
}

function percent(part: number, whole: number) {
  return whole > 0 ? round1((part / whole) * 100) : 0;
}

function formatLabel(value: unknown, fallback = "Uncategorized") {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  return raw
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function cacheKey(report: string, filters: ReturnType<typeof normalizeFilters>) {
  return JSON.stringify({ report, filters });
}

function monthRange(from: string, to: string) {
  const start = new Date(`${from.slice(0, 7)}-01T00:00:00.000Z`);
  const end = new Date(`${to.slice(0, 7)}-01T00:00:00.000Z`);
  const months: string[] = [];
  for (const cursor = new Date(start); cursor <= end; cursor.setUTCMonth(cursor.getUTCMonth() + 1)) {
    months.push(cursor.toISOString().slice(0, 7));
  }
  return months;
}

export function computePreviousPeriod(from: string, to: string) {
  const start = new Date(`${from}T00:00:00.000Z`);
  const endExclusive = new Date(`${to}T00:00:00.000Z`);
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
  const days = Math.max(1, Math.round((endExclusive.getTime() - start.getTime()) / 86400000));
  const previousFrom = new Date(start);
  previousFrom.setUTCDate(previousFrom.getUTCDate() - days);
  return {
    previousFrom: previousFrom.toISOString().slice(0, 10),
    previousToExclusive: start.toISOString().slice(0, 10),
    days,
  };
}

function changePercent(current: number, previous: number) {
  if (previous === 0) return current === 0 ? 0 : 100;
  return round1(((current - previous) / Math.abs(previous)) * 100);
}

function direction(change: number): "up" | "down" | "flat" {
  if (change > 0) return "up";
  if (change < 0) return "down";
  return "flat";
}

export async function getMarketMixReport(
  tenantDb: TenantDb,
  input: AnalyticsTier4Filters = {}
): Promise<MarketMixReport> {
  const filters = normalizeFilters(input);
  return cached(tenantDb, cacheKey("market-mix", filters), async () => {
    const where = buildWhere(filters);
    const outcomeWhere = buildWhere(filters, sql`COALESCE(d.actual_close_date, d.lost_at, d.updated_at)`);
    const verticalExpr = sql`COALESCE(NULLIF(c.industry::text, ''), NULLIF(d.project_type, ''), 'Uncategorized')`;
    const regionExpr = sql`COALESCE(NULLIF(c.region, ''), NULLIF(rc.name, ''), NULLIF(p.city, ''), NULLIF(p.state, ''), NULLIF(d.property_city, ''), NULLIF(d.property_state, ''), 'Uncategorized')`;
    const propertyTypeExpr = sql`COALESCE(NULLIF(p.property_type, ''), NULLIF(p.type::text, ''), 'Uncategorized')`;
    const valueExpr = sql`COALESCE(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0)`;

    const [kpiRows, verticalRows, propertyRows, regionRows, quarterlyRows, breakdownRows] = await Promise.all([
      tenantDb.execute(sql`
        SELECT
          COUNT(DISTINCT d.id)::int AS total_deal_count,
          COALESCE(SUM(${valueExpr}) FILTER (WHERE psc.slug IN (${sqlStringList(WON_STAGE_SLUGS)})), 0)::numeric AS total_won_value,
          COUNT(DISTINCT ${verticalExpr})::int AS active_markets,
          COALESCE((
            SELECT ${regionExpr}
            FROM deals d
            LEFT JOIN companies c ON c.id = d.company_id
            LEFT JOIN properties p ON p.id = d.property_id
            LEFT JOIN region_config rc ON rc.id = d.region_id
            LEFT JOIN users u ON u.id = d.assigned_rep_id
            WHERE ${where}
            GROUP BY ${regionExpr}
            ORDER BY COUNT(*) DESC
            LIMIT 1
          ), 'Uncategorized') AS most_active_region
        FROM deals d
        LEFT JOIN companies c ON c.id = d.company_id
        LEFT JOIN properties p ON p.id = d.property_id
        LEFT JOIN region_config rc ON rc.id = d.region_id
        LEFT JOIN users u ON u.id = d.assigned_rep_id
        LEFT JOIN pipeline_stage_config psc ON psc.id = d.stage_id
        WHERE ${where}
      `),
      tenantDb.execute(sql`
        SELECT ${verticalExpr} AS name,
          COUNT(DISTINCT d.id)::int AS deal_count,
          COALESCE(SUM(${valueExpr}) FILTER (WHERE psc.slug IN (${sqlStringList(WON_STAGE_SLUGS)})), 0)::numeric AS won_value
        FROM deals d
        LEFT JOIN companies c ON c.id = d.company_id
        LEFT JOIN properties p ON p.id = d.property_id
        LEFT JOIN region_config rc ON rc.id = d.region_id
        LEFT JOIN users u ON u.id = d.assigned_rep_id
        LEFT JOIN pipeline_stage_config psc ON psc.id = d.stage_id
        WHERE ${where}
        GROUP BY ${verticalExpr}
        ORDER BY deal_count DESC, won_value DESC
        LIMIT 12
      `),
      tenantDb.execute(sql`
        SELECT ${propertyTypeExpr} AS name,
          COUNT(DISTINCT d.id)::int AS deal_count,
          COALESCE(SUM(${valueExpr}) FILTER (WHERE psc.slug IN (${sqlStringList(WON_STAGE_SLUGS)})), 0)::numeric AS won_value
        FROM deals d
        LEFT JOIN companies c ON c.id = d.company_id
        LEFT JOIN properties p ON p.id = d.property_id
        LEFT JOIN region_config rc ON rc.id = d.region_id
        LEFT JOIN users u ON u.id = d.assigned_rep_id
        LEFT JOIN pipeline_stage_config psc ON psc.id = d.stage_id
        WHERE ${where}
        GROUP BY ${propertyTypeExpr}
        ORDER BY deal_count DESC, won_value DESC
        LIMIT 12
      `),
      tenantDb.execute(sql`
        SELECT ${regionExpr} AS name,
          COUNT(DISTINCT d.id)::int AS deal_count,
          COALESCE(SUM(${valueExpr}) FILTER (WHERE psc.slug IN (${sqlStringList(WON_STAGE_SLUGS)})), 0)::numeric AS won_value
        FROM deals d
        LEFT JOIN companies c ON c.id = d.company_id
        LEFT JOIN properties p ON p.id = d.property_id
        LEFT JOIN region_config rc ON rc.id = d.region_id
        LEFT JOIN users u ON u.id = d.assigned_rep_id
        LEFT JOIN pipeline_stage_config psc ON psc.id = d.stage_id
        WHERE ${where}
        GROUP BY ${regionExpr}
        ORDER BY deal_count DESC, won_value DESC
        LIMIT 12
      `),
      tenantDb.execute(sql`
        SELECT
          CONCAT(EXTRACT(YEAR FROM COALESCE(d.actual_close_date, d.updated_at) AT TIME ZONE 'UTC')::int, ' Q', EXTRACT(QUARTER FROM COALESCE(d.actual_close_date, d.updated_at) AT TIME ZONE 'UTC')::int) AS quarter,
          ${verticalExpr} AS vertical,
          COALESCE(SUM(${valueExpr}), 0)::numeric AS won_value
        FROM deals d
        LEFT JOIN companies c ON c.id = d.company_id
        LEFT JOIN properties p ON p.id = d.property_id
        LEFT JOIN region_config rc ON rc.id = d.region_id
        LEFT JOIN users u ON u.id = d.assigned_rep_id
        JOIN pipeline_stage_config psc ON psc.id = d.stage_id
        WHERE ${outcomeWhere}
          AND psc.slug IN (${sqlStringList(WON_STAGE_SLUGS)})
        GROUP BY quarter, ${verticalExpr}
        ORDER BY quarter ASC, won_value DESC
      `),
      tenantDb.execute(sql`
        SELECT ${verticalExpr} AS vertical,
          COUNT(DISTINCT d.id) FILTER (WHERE psc.is_terminal = false)::int AS active_deals,
          COALESCE(SUM(${valueExpr}) FILTER (WHERE psc.slug IN (${sqlStringList(WON_STAGE_SLUGS)})), 0)::numeric AS won_last_year,
          COUNT(DISTINCT d.id) FILTER (WHERE psc.slug IN (${sqlStringList(WON_STAGE_SLUGS)}))::int AS wins,
          COUNT(DISTINCT d.id) FILTER (WHERE psc.slug IN (${sqlStringList(LOST_STAGE_SLUGS)}))::int AS losses,
          COALESCE(AVG(${valueExpr}) FILTER (WHERE psc.slug IN (${sqlStringList(WON_STAGE_SLUGS)})), 0)::numeric AS avg_deal_size
        FROM deals d
        LEFT JOIN companies c ON c.id = d.company_id
        LEFT JOIN properties p ON p.id = d.property_id
        LEFT JOIN region_config rc ON rc.id = d.region_id
        LEFT JOIN users u ON u.id = d.assigned_rep_id
        LEFT JOIN pipeline_stage_config psc ON psc.id = d.stage_id
        WHERE ${where}
        GROUP BY ${verticalExpr}
        ORDER BY won_last_year DESC, active_deals DESC
        LIMIT 20
      `),
    ]);

    const kpis = rowsFromExecute<any>(kpiRows)[0] ?? {};
    return {
      kpis: {
        totalDealCount: numberFrom(kpis.total_deal_count),
        totalWonValue: numberFrom(kpis.total_won_value),
        activeMarkets: numberFrom(kpis.active_markets),
        mostActiveRegion: formatLabel(kpis.most_active_region),
      },
      verticalMix: rowsFromExecute<any>(verticalRows).map((row) => ({
        name: formatLabel(row.name),
        dealCount: numberFrom(row.deal_count),
        wonValue: numberFrom(row.won_value),
      })),
      propertyTypeMix: rowsFromExecute<any>(propertyRows).map((row) => ({
        name: formatLabel(row.name),
        dealCount: numberFrom(row.deal_count),
        wonValue: numberFrom(row.won_value),
      })),
      regionMix: rowsFromExecute<any>(regionRows).map((row) => ({
        name: formatLabel(row.name),
        dealCount: numberFrom(row.deal_count),
        wonValue: numberFrom(row.won_value),
      })),
      quarterlyWonByVertical: rowsFromExecute<any>(quarterlyRows).map((row) => ({
        quarter: String(row.quarter ?? ""),
        vertical: formatLabel(row.vertical),
        wonValue: numberFrom(row.won_value),
      })),
      breakdown: rowsFromExecute<any>(breakdownRows).map((row) => {
        const wins = numberFrom(row.wins);
        const losses = numberFrom(row.losses);
        return {
          vertical: formatLabel(row.vertical),
          activeDeals: numberFrom(row.active_deals),
          wonLastYear: numberFrom(row.won_last_year),
          winRate: percent(wins, wins + losses),
          avgDealSize: numberFrom(row.avg_deal_size),
        };
      }),
      proxyNotes: [
        "Vertical uses company industry when present; deal project type is the fallback proxy.",
        "Region uses company region, configured deal region, then property/deal geography fallback.",
      ],
    };
  });
}

export async function getCustomerConcentrationReport(
  tenantDb: TenantDb,
  input: AnalyticsTier4Filters = {}
): Promise<CustomerConcentrationReport> {
  const filters = normalizeFilters(input);
  return cached(tenantDb, cacheKey("customer-concentration", filters), async () => {
    const where = buildWhere(filters);
    const valueExpr = sql`COALESCE(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0)`;
    const openValueExpr = sql`COALESCE(d.forecast_revenue, d.bid_estimate, d.dd_estimate, 0)`;

    const [kpiRows, customerRows, distributionRows, staleRows] = await Promise.all([
      tenantDb.execute(sql`
        WITH open_customers AS (
          SELECT d.company_id, SUM(${openValueExpr}) AS open_value
          FROM deals d
          LEFT JOIN users u ON u.id = d.assigned_rep_id
          JOIN pipeline_stage_config psc ON psc.id = d.stage_id
          WHERE ${where}
            AND psc.is_terminal = false
            AND d.company_id IS NOT NULL
          GROUP BY d.company_id
        )
        SELECT
          COUNT(*)::int AS total_active_customers,
          COALESCE(SUM(open_value), 0)::numeric AS total_open_value,
          COUNT(*) FILTER (WHERE open_value >= 1000000)::int AS customers_over_one_million_open
        FROM open_customers
      `),
      tenantDb.execute(sql`
        SELECT
          d.company_id::text AS company_id,
          COALESCE(c.name, 'Unassigned Account') AS company_name,
          COUNT(DISTINCT d.id) FILTER (WHERE psc.is_terminal = false)::int AS active_deals,
          COALESCE(SUM(${openValueExpr}) FILTER (WHERE psc.is_terminal = false), 0)::numeric AS total_open_value,
          COALESCE(SUM(${valueExpr}) FILTER (WHERE psc.slug IN (${sqlStringList(WON_STAGE_SLUGS)})), 0)::numeric AS total_won_lifetime,
          MAX(COALESCE(d.last_activity_at, c.last_activity_at, a.last_activity_at, d.updated_at)) AS last_activity_at,
          COALESCE(STRING_AGG(DISTINCT rep.display_name, ', ' ORDER BY rep.display_name) FILTER (WHERE rep.display_name IS NOT NULL), 'Unassigned') AS account_owners
        FROM deals d
        LEFT JOIN companies c ON c.id = d.company_id
        LEFT JOIN users u ON u.id = d.assigned_rep_id
        LEFT JOIN users rep ON rep.id = d.assigned_rep_id
        LEFT JOIN pipeline_stage_config psc ON psc.id = d.stage_id
        LEFT JOIN (
          SELECT deal_id, MAX(occurred_at) AS last_activity_at
          FROM activities
          GROUP BY deal_id
        ) a ON a.deal_id = d.id
        WHERE ${where}
          AND d.company_id IS NOT NULL
        GROUP BY d.company_id, COALESCE(c.name, 'Unassigned Account')
        HAVING COUNT(DISTINCT d.id) FILTER (WHERE psc.is_terminal = false) > 0
        ORDER BY total_open_value DESC
        LIMIT 20
      `),
      tenantDb.execute(sql`
        WITH customer_values AS (
          SELECT d.company_id, SUM(${openValueExpr}) AS open_value
          FROM deals d
          LEFT JOIN users u ON u.id = d.assigned_rep_id
          JOIN pipeline_stage_config psc ON psc.id = d.stage_id
          WHERE ${where}
            AND psc.is_terminal = false
            AND d.company_id IS NOT NULL
          GROUP BY d.company_id
        )
        SELECT
          CASE
            WHEN open_value >= 1000000 THEN '$1M+'
            WHEN open_value >= 500000 THEN '$500K-$999K'
            WHEN open_value >= 100000 THEN '$100K-$499K'
            ELSE '<$100K'
          END AS bucket,
          COUNT(*)::int AS customer_count
        FROM customer_values
        GROUP BY bucket
        ORDER BY MIN(open_value) DESC
      `),
      tenantDb.execute(sql`
        SELECT
          d.company_id::text AS company_id,
          COALESCE(c.name, 'Unassigned Account') AS company_name,
          COALESCE(STRING_AGG(DISTINCT rep.display_name, ', ' ORDER BY rep.display_name) FILTER (WHERE rep.display_name IS NOT NULL), 'Unassigned') AS owner_name,
          COUNT(DISTINCT d.id)::int AS open_deals,
          COALESCE(SUM(${openValueExpr}), 0)::numeric AS open_value,
          FLOOR(EXTRACT(EPOCH FROM (NOW() - MAX(COALESCE(d.last_activity_at, c.last_activity_at, a.last_activity_at, d.updated_at)))) / 86400)::int AS days_stale
        FROM deals d
        LEFT JOIN companies c ON c.id = d.company_id
        LEFT JOIN users u ON u.id = d.assigned_rep_id
        LEFT JOIN users rep ON rep.id = d.assigned_rep_id
        JOIN pipeline_stage_config psc ON psc.id = d.stage_id
        LEFT JOIN (
          SELECT deal_id, MAX(occurred_at) AS last_activity_at
          FROM activities
          GROUP BY deal_id
        ) a ON a.deal_id = d.id
        WHERE ${where}
          AND psc.is_terminal = false
          AND d.company_id IS NOT NULL
        GROUP BY d.company_id, COALESCE(c.name, 'Unassigned Account')
        HAVING FLOOR(EXTRACT(EPOCH FROM (NOW() - MAX(COALESCE(d.last_activity_at, c.last_activity_at, a.last_activity_at, d.updated_at)))) / 86400)::int >= 60
        ORDER BY days_stale DESC, open_value DESC
        LIMIT 20
      `),
    ]);

    const kpi = rowsFromExecute<any>(kpiRows)[0] ?? {};
    const topCustomers = rowsFromExecute<any>(customerRows).map((row) => ({
      companyId: String(row.company_id),
      companyName: String(row.company_name ?? "Unassigned Account"),
      activeDeals: numberFrom(row.active_deals),
      totalOpenValue: numberFrom(row.total_open_value),
      totalWonLifetime: numberFrom(row.total_won_lifetime),
      lastActivityAt: row.last_activity_at ? new Date(row.last_activity_at).toISOString() : null,
      accountOwners: String(row.account_owners ?? "Unassigned"),
    }));
    const totalOpenValue = numberFrom(kpi.total_open_value);
    let cumulative = 0;

    return {
      kpis: {
        totalActiveCustomers: numberFrom(kpi.total_active_customers),
        totalOpenValue,
        topCustomerPipelinePercent: percent(topCustomers[0]?.totalOpenValue ?? 0, totalOpenValue),
        customersOverOneMillionOpen: numberFrom(kpi.customers_over_one_million_open),
      },
      scopeNote: "Customer concentration excludes deals without a company/account from customer totals and ranking.",
      topCustomers,
      pareto: topCustomers.map((customer, index) => {
        cumulative += customer.totalOpenValue;
        return {
          rank: index + 1,
          companyId: customer.companyId,
          companyName: customer.companyName,
          pipelineValue: customer.totalOpenValue,
          cumulativePipelinePercent: percent(cumulative, totalOpenValue),
        };
      }),
      distribution: rowsFromExecute<any>(distributionRows).map((row) => ({
        bucket: String(row.bucket ?? "Unknown"),
        customerCount: numberFrom(row.customer_count),
      })),
      staleCustomers: rowsFromExecute<any>(staleRows).map((row) => ({
        companyName: String(row.company_name ?? "Unassigned Account"),
        ownerName: String(row.owner_name ?? "Unassigned"),
        openDeals: numberFrom(row.open_deals),
        openValue: numberFrom(row.open_value),
        daysStale: numberFrom(row.days_stale),
      })),
    };
  });
}

export async function getExecutiveTrendsReport(
  tenantDb: TenantDb,
  input: AnalyticsTier4Filters = {}
): Promise<ExecutiveTrendsReport> {
  const filters = normalizeFilters(input);
  return cached(tenantDb, cacheKey("executive-trends", filters), async () => {
    const where = buildWhere(filters);
    const valueExpr = sql`COALESCE(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0)`;
    const openValueExpr = sql`COALESCE(d.forecast_revenue, d.bid_estimate, d.dd_estimate, 0)`;
    const previousPeriod = computePreviousPeriod(filters.from, filters.to);

    const [kpiRows, monthlyRows, quarterlyRows, winRateRows, progressionRows] = await Promise.all([
      tenantDb.execute(sql`
        WITH periods AS (
          SELECT 'current' AS metric, ${filters.from}::timestamptz AS from_date, (${filters.to}::date + INTERVAL '1 day')::timestamptz AS to_date
          UNION ALL
          SELECT 'previous' AS metric, ${previousPeriod.previousFrom}::timestamptz AS from_date, ${previousPeriod.previousToExclusive}::timestamptz AS to_date
        )
        SELECT
          p.metric,
          COALESCE(SUM(${openValueExpr}) FILTER (WHERE psc.is_terminal = false), 0)::numeric AS total_pipeline,
          COALESCE(SUM(${valueExpr}) FILTER (WHERE psc.slug IN (${sqlStringList(WON_STAGE_SLUGS)})), 0)::numeric AS won_revenue,
          COUNT(*) FILTER (WHERE psc.slug IN (${sqlStringList(WON_STAGE_SLUGS)}))::int AS wins,
          COUNT(*) FILTER (WHERE psc.slug IN (${sqlStringList(LOST_STAGE_SLUGS)}))::int AS losses,
          COALESCE(AVG(${valueExpr}) FILTER (WHERE psc.slug IN (${sqlStringList(WON_STAGE_SLUGS)})), 0)::numeric AS avg_deal_size
        FROM periods p
        LEFT JOIN deals d ON d.created_at >= p.from_date AND d.created_at < p.to_date
        LEFT JOIN users u ON u.id = d.assigned_rep_id
        LEFT JOIN pipeline_stage_config psc ON psc.id = d.stage_id
        WHERE d.id IS NULL OR (
          ${buildScopeWhere(filters)}
          AND d.created_at >= p.from_date
          AND d.created_at < p.to_date
        )
        GROUP BY p.metric
      `),
      tenantDb.execute(sql`
        WITH months AS (
          SELECT TO_CHAR(month_start, 'YYYY-MM') AS month
          FROM generate_series(
            date_trunc('month', ${filters.from}::timestamptz AT TIME ZONE 'UTC'),
            date_trunc('month', ${filters.to}::timestamptz AT TIME ZONE 'UTC'),
            INTERVAL '1 month'
          ) month_start
        ),
        new_deals AS (
          SELECT TO_CHAR(d.created_at AT TIME ZONE 'UTC', 'YYYY-MM') AS month,
            COUNT(DISTINCT d.id)::int AS new_deals
          FROM deals d
          LEFT JOIN users u ON u.id = d.assigned_rep_id
          WHERE ${where}
          GROUP BY TO_CHAR(d.created_at AT TIME ZONE 'UTC', 'YYYY-MM')
        ),
        won_history AS (
          SELECT TO_CHAR(dsh.created_at AT TIME ZONE 'UTC', 'YYYY-MM') AS month,
            COUNT(DISTINCT dsh.deal_id)::int AS won_deals
          FROM deal_stage_history dsh
          JOIN deals d ON d.id = dsh.deal_id
          LEFT JOIN users u ON u.id = d.assigned_rep_id
          JOIN pipeline_stage_config to_stage ON to_stage.id = dsh.to_stage_id
          WHERE ${buildWhere(filters, sql`dsh.created_at`)}
            AND to_stage.slug IN (${sqlStringList(WON_STAGE_SLUGS)})
          GROUP BY TO_CHAR(dsh.created_at AT TIME ZONE 'UTC', 'YYYY-MM')
        ),
        won_fallback AS (
          SELECT TO_CHAR(COALESCE(d.actual_close_date::timestamptz, d.updated_at) AT TIME ZONE 'UTC', 'YYYY-MM') AS month,
            COUNT(DISTINCT d.id)::int AS won_deals
          FROM deals d
          LEFT JOIN users u ON u.id = d.assigned_rep_id
          JOIN pipeline_stage_config psc ON psc.id = d.stage_id
          WHERE ${buildWhere(filters, sql`COALESCE(d.actual_close_date::timestamptz, d.updated_at)`)}
            AND psc.slug IN (${sqlStringList(WON_STAGE_SLUGS)})
            AND NOT EXISTS (
              SELECT 1
              FROM deal_stage_history history
              JOIN pipeline_stage_config history_stage ON history_stage.id = history.to_stage_id
              WHERE history.deal_id = d.id
                AND history_stage.slug IN (${sqlStringList(WON_STAGE_SLUGS)})
            )
          GROUP BY TO_CHAR(COALESCE(d.actual_close_date::timestamptz, d.updated_at) AT TIME ZONE 'UTC', 'YYYY-MM')
        ),
        lost_history AS (
          SELECT TO_CHAR(dsh.created_at AT TIME ZONE 'UTC', 'YYYY-MM') AS month,
            COUNT(DISTINCT dsh.deal_id)::int AS lost_deals
          FROM deal_stage_history dsh
          JOIN deals d ON d.id = dsh.deal_id
          LEFT JOIN users u ON u.id = d.assigned_rep_id
          JOIN pipeline_stage_config to_stage ON to_stage.id = dsh.to_stage_id
          WHERE ${buildWhere(filters, sql`dsh.created_at`)}
            AND to_stage.slug IN (${sqlStringList(LOST_STAGE_SLUGS)})
          GROUP BY TO_CHAR(dsh.created_at AT TIME ZONE 'UTC', 'YYYY-MM')
        ),
        lost_fallback AS (
          SELECT TO_CHAR(COALESCE(d.lost_at, d.updated_at) AT TIME ZONE 'UTC', 'YYYY-MM') AS month,
            COUNT(DISTINCT d.id)::int AS lost_deals
          FROM deals d
          LEFT JOIN users u ON u.id = d.assigned_rep_id
          JOIN pipeline_stage_config psc ON psc.id = d.stage_id
          WHERE ${buildWhere(filters, sql`COALESCE(d.lost_at, d.updated_at)`)}
            AND psc.slug IN (${sqlStringList(LOST_STAGE_SLUGS)})
            AND NOT EXISTS (
              SELECT 1
              FROM deal_stage_history history
              JOIN pipeline_stage_config history_stage ON history_stage.id = history.to_stage_id
              WHERE history.deal_id = d.id
                AND history_stage.slug IN (${sqlStringList(LOST_STAGE_SLUGS)})
            )
          GROUP BY TO_CHAR(COALESCE(d.lost_at, d.updated_at) AT TIME ZONE 'UTC', 'YYYY-MM')
        ),
        current_pipeline AS (
          SELECT COALESCE(SUM(${openValueExpr}), 0)::numeric AS active_pipeline_value
          FROM deals d
          LEFT JOIN users u ON u.id = d.assigned_rep_id
          JOIN pipeline_stage_config psc ON psc.id = d.stage_id
          WHERE ${buildScopeWhere(filters)}
            AND psc.is_terminal = false
        )
        SELECT
          months.month,
          COALESCE(new_deals.new_deals, 0)::int AS new_deals,
          (COALESCE(won_history.won_deals, 0) + COALESCE(won_fallback.won_deals, 0))::int AS won_deals,
          (COALESCE(lost_history.lost_deals, 0) + COALESCE(lost_fallback.lost_deals, 0))::int AS lost_deals,
          current_pipeline.active_pipeline_value
        FROM months
        CROSS JOIN current_pipeline
        LEFT JOIN new_deals ON new_deals.month = months.month
        LEFT JOIN won_history ON won_history.month = months.month
        LEFT JOIN won_fallback ON won_fallback.month = months.month
        LEFT JOIN lost_history ON lost_history.month = months.month
        LEFT JOIN lost_fallback ON lost_fallback.month = months.month
        ORDER BY months.month ASC
      `),
      tenantDb.execute(sql`
        SELECT
          CONCAT(EXTRACT(YEAR FROM d.created_at AT TIME ZONE 'UTC')::int, ' Q', EXTRACT(QUARTER FROM d.created_at AT TIME ZONE 'UTC')::int) AS quarter,
          COUNT(DISTINCT d.id)::int AS deals_created,
          COUNT(DISTINCT d.id) FILTER (WHERE psc.slug IN (${sqlStringList(WON_STAGE_SLUGS)}))::int AS won,
          COUNT(DISTINCT d.id) FILTER (WHERE psc.slug IN (${sqlStringList(LOST_STAGE_SLUGS)}))::int AS lost,
          COALESCE(AVG(${valueExpr}) FILTER (WHERE psc.slug IN (${sqlStringList(WON_STAGE_SLUGS)})), 0)::numeric AS avg_deal_size,
          COALESCE(SUM(${openValueExpr}) FILTER (WHERE psc.is_terminal = false), 0)::numeric AS pipeline_end_value
        FROM deals d
        LEFT JOIN users u ON u.id = d.assigned_rep_id
        LEFT JOIN pipeline_stage_config psc ON psc.id = d.stage_id
        WHERE ${where}
        GROUP BY quarter
        ORDER BY quarter ASC
      `),
      tenantDb.execute(sql`
        SELECT
          TO_CHAR(dsh.created_at AT TIME ZONE 'UTC', 'YYYY-MM') AS month,
          COUNT(*) FILTER (WHERE psc.slug IN (${sqlStringList(WON_STAGE_SLUGS)}))::int AS wins,
          COUNT(*) FILTER (WHERE psc.slug IN (${sqlStringList(LOST_STAGE_SLUGS)}))::int AS losses
        FROM deal_stage_history dsh
        JOIN deals d ON d.id = dsh.deal_id
        LEFT JOIN users u ON u.id = d.assigned_rep_id
        JOIN pipeline_stage_config psc ON psc.id = dsh.to_stage_id
        WHERE ${buildWhere(filters, sql`dsh.created_at`)}
          AND psc.is_terminal = true
        GROUP BY TO_CHAR(dsh.created_at AT TIME ZONE 'UTC', 'YYYY-MM')
        ORDER BY month ASC
      `),
      tenantDb.execute(sql`
        SELECT
          COALESCE(from_stage.name, 'Initial') AS stage_name,
          COUNT(*)::int AS entered_count,
          COUNT(*) FILTER (WHERE to_stage.display_order > COALESCE(from_stage.display_order, -1))::int AS advanced_count
        FROM deal_stage_history dsh
        JOIN deals d ON d.id = dsh.deal_id
        LEFT JOIN users u ON u.id = d.assigned_rep_id
        LEFT JOIN pipeline_stage_config from_stage ON from_stage.id = dsh.from_stage_id
        JOIN pipeline_stage_config to_stage ON to_stage.id = dsh.to_stage_id
        WHERE ${buildWhere(filters, sql`dsh.created_at`)}
        GROUP BY COALESCE(from_stage.name, 'Initial')
        ORDER BY entered_count DESC
      `),
    ]);

    const periodRows = rowsFromExecute<any>(kpiRows);
    const current = periodRows.find((row) => row.metric === "current") ?? {};
    const previous = periodRows.find((row) => row.metric === "previous") ?? {};
    const currentWins = numberFrom(current.wins);
    const currentLosses = numberFrom(current.losses);
    const previousWins = numberFrom(previous.wins);
    const previousLosses = numberFrom(previous.losses);
    const metrics = [
      {
        label: "Total Pipeline",
        value: numberFrom(current.total_pipeline),
        previous: numberFrom(previous.total_pipeline),
        format: "currency" as const,
      },
      {
        label: "Won Revenue",
        value: numberFrom(current.won_revenue),
        previous: numberFrom(previous.won_revenue),
        format: "currency" as const,
      },
      {
        label: "Win Rate",
        value: percent(currentWins, currentWins + currentLosses),
        previous: percent(previousWins, previousWins + previousLosses),
        format: "percent" as const,
      },
      {
        label: "Avg Deal Size",
        value: numberFrom(current.avg_deal_size),
        previous: numberFrom(previous.avg_deal_size),
        format: "currency" as const,
      },
    ];
    const monthlyByKey = new Map(
      rowsFromExecute<any>(monthlyRows).map((row) => [
        String(row.month),
        {
          month: String(row.month),
          newDeals: numberFrom(row.new_deals),
          wonDeals: numberFrom(row.won_deals),
          lostDeals: numberFrom(row.lost_deals),
          activePipelineValue: numberFrom(row.active_pipeline_value),
        },
      ])
    );
    const winRateByKey = new Map(
      rowsFromExecute<any>(winRateRows).map((row) => {
        const wins = numberFrom(row.wins);
        const losses = numberFrom(row.losses);
        return [String(row.month), { month: String(row.month), winRate: percent(wins, wins + losses) }];
      })
    );

    return {
      kpis: metrics.map((metric) => {
        const change = changePercent(metric.value, metric.previous);
        return {
          label: metric.label,
          value: metric.value,
          changePercent: change,
          direction: direction(change),
          format: metric.format,
        };
      }),
      monthlyTrends: monthRange(filters.from, filters.to).map(
        (month) =>
          monthlyByKey.get(month) ?? {
            month,
            newDeals: 0,
            wonDeals: 0,
            lostDeals: 0,
            activePipelineValue: 0,
          }
      ),
      activePipelineNote:
        "Active pipeline is a current open-pipeline snapshot repeated across the selected months; historical month-end pipeline snapshots are not available.",
      quarterlyComparison: rowsFromExecute<any>(quarterlyRows).map((row) => {
        const won = numberFrom(row.won);
        const lost = numberFrom(row.lost);
        return {
          quarter: String(row.quarter ?? ""),
          dealsCreated: numberFrom(row.deals_created),
          won,
          lost,
          winRate: percent(won, won + lost),
          avgDealSize: numberFrom(row.avg_deal_size),
          pipelineEndValue: numberFrom(row.pipeline_end_value),
        };
      }),
      winRateTrend: monthRange(filters.from, filters.to).map((month) => winRateByKey.get(month) ?? { month, winRate: 0 }),
      stageProgression: rowsFromExecute<any>(progressionRows).map((row) => {
        const enteredCount = numberFrom(row.entered_count);
        const advancedCount = numberFrom(row.advanced_count);
        return {
          stageName: formatLabel(row.stage_name, "Initial"),
          enteredCount,
          advancedCount,
          progressionRate: percent(advancedCount, enteredCount),
        };
      }),
    };
  });
}
