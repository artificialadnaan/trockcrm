import { sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { buildOfficeExistsMatcher } from "./office-filter.js";
import {
  aliasedActiveDealCountFilterSql,
  aliasedEffectiveDealValueSql,
  aliasedEffectiveWonDealValueSql,
  aliasedOpenPipelineForecastFirstDealValueSql,
  aliasedReportableDealFilterSql,
  aliasedWonHsClosedWonDateSql,
} from "../shared/deal-value-sql.js";
import { aliasedHasUsableWonDateSql } from "../deals/service.js";
import { LOST_STAGE_SLUGS, WON_STAGE_SLUGS } from "../shared/pipeline-terminal-stages.js";
// Estimator-aware rep filter (PR 2): owner IN-list matches assigned_rep OR estimator_user_id.
import { buildAliasedInvolvedRepInListSql } from "../deals/deal-filter-predicates.js";

type TenantDb = NodePgDatabase<typeof schema>;
type ExecuteRows<T> = { rows: T[] } | T[];

const CACHE_TTL_MS = 5 * 60 * 1000;

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

function buildWhere(
  filters: ReturnType<typeof normalizeFilters>,
  dateColumn: SQL = sql`d.created_at`,
  options: { requireActive?: boolean } = {}
) {
  return sql`
    ${buildScopeWhere(filters, options)}
    AND ${dateColumn} >= (${filters.from}::date AT TIME ZONE 'UTC')
    AND ${dateColumn} < ((${filters.to}::date + INTERVAL '1 day') AT TIME ZONE 'UTC')
  `;
}

// Won-period window on the canonical deals.won_closed_date. Uses DATE-typed bounds (no
// AT TIME ZONE) so the comparison is session-time-zone-independent — matching the other
// won_closed_date report sites and the dashboard getWonCloseSummary. Routing the date column
// through buildWhere instead would compare it to `AT TIME ZONE 'UTC'` timestamptz bounds, which
// for a non-UTC DB session (office_dallas runs Central) shifts boundary dates and can drop/move
// a win whose canonical won date equals the period edge.
function buildWonClosedWhere(filters: ReturnType<typeof normalizeFilters>) {
  const won = aliasedWonHsClosedWonDateSql("d");
  return sql`
    ${buildScopeWhere(filters)}
    AND ${won} >= ${filters.from}::date
    AND ${won} <= ${filters.to}::date
  `;
}

/**
 * Owner narrowing for the analytics tiers: estimator-aware id IN-list (PR 2 — matches assigned_rep OR
 * estimator_user_id, "value"/::uuid cast preserved) with a display-name fallback. Exported so the runtime
 * test can prove an estimator-only person's deals surface here. Carries the leading AND for interpolation.
 */
export function buildOwnerScopeSql(
  filters: Pick<ReturnType<typeof normalizeFilters>, "ownerIds" | "ownerNames">
): SQL {
  return filters.ownerIds.length
    ? sql`AND ${buildAliasedInvolvedRepInListSql("d", filters.ownerIds, "value")!}`
    : filters.ownerNames.length
      // Estimator-aware by NAME too (Codex P2): match the assigned rep's name OR a deal whose resolved
      // estimator has a listed name (name->id subquery on estimator_user_id). The consuming queries LEFT
      // JOIN users on the assigned rep, so an unassigned-but-estimated deal still surfaces via the subquery.
      ? sql`AND (u.display_name IN (${sqlStringList(filters.ownerNames)}) OR d.estimator_user_id IN (
          SELECT eu.id FROM users eu WHERE eu.display_name IN (${sqlStringList(filters.ownerNames)})
        ))`
    : sql``;
}

// CC4 (Wave 0): `requireActive` adds `d.is_active = true` to scope the ACTIVE/open cohort (deal counts,
// pipeline) so soft-deleted deals are excluded. It DEFAULTS OFF: the WON cohort (buildWonClosedWhere /
// buildWonByDimensionSql) and any historical deal_stage_history cohort must NOT require is_active —
// terminal wins get archived (is_active=false) and the canonical getWonCloseSummary still counts them, so
// forcing is_active on a Won figure would undercount it (see report-builder-service.ts:226-229 and the
// dashboard getWonCloseSummary). Active call sites pass { requireActive: true } explicitly.
function buildScopeWhere(
  filters: ReturnType<typeof normalizeFilters>,
  options: { requireActive?: boolean } = {}
) {
  const ownerFilter = buildOwnerScopeSql(filters);
  const officeClause = buildOfficeExistsMatcher(filters.office);
  const officeFilter = officeClause ? sql`AND ${officeClause}` : sql``;
  const activeFilter = options.requireActive ? sql`AND d.is_active = true` : sql``;

  return sql`
    COALESCE(d.is_test_data, false) = false
    AND ${aliasedReportableDealFilterSql("d")}
    ${activeFilter}
    ${ownerFilter}
    ${officeFilter}
  `;
}

interface WonDimensionEntry {
  wonValue: number;
  avgWon: number;
  wonCount: number;
}

// WON cohort aggregated by a dimension expression. The WHERE is byte-identical to the dashboard
// getWonCloseSummary (scope, requireActive:false → archived wins included, WON stage gate, usable-won-date
// guard, canonical deals.won_closed_date window with DATE-typed bounds) — so the Won figures it feeds
// reconcile to the quarterly Won-by-vertical panel by construction (CC1).
function buildWonByDimensionSql(filters: ReturnType<typeof normalizeFilters>, dimensionExpr: SQL): SQL {
  const wonValue = aliasedEffectiveWonDealValueSql("d");
  return sql`
    SELECT ${dimensionExpr} AS name,
      COALESCE(SUM(${wonValue}), 0)::numeric AS won_value,
      COALESCE(AVG(${wonValue}), 0)::numeric AS avg_won_value,
      COUNT(DISTINCT d.id)::int AS won_count
    FROM deals d
    LEFT JOIN companies c ON c.id = d.company_id
    LEFT JOIN properties p ON p.id = d.property_id
    LEFT JOIN region_config rc ON rc.id = d.region_id
    LEFT JOIN users u ON u.id = d.assigned_rep_id
    JOIN pipeline_stage_config psc ON psc.id = d.stage_id
    WHERE ${buildWonClosedWhere(filters)}
      AND psc.slug IN (${sqlStringList(WON_STAGE_SLUGS)})
      AND ${aliasedHasUsableWonDateSql("d")}
    GROUP BY ${dimensionExpr}
  `;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wonDimensionMap(rows: ExecuteRows<any>): Map<string, WonDimensionEntry> {
  const map = new Map<string, WonDimensionEntry>();
  for (const row of rowsFromExecute<any>(rows)) {
    map.set(String(row.name ?? "Uncategorized"), {
      wonValue: numberFrom(row.won_value),
      avgWon: numberFrom(row.avg_won_value),
      wonCount: numberFrom(row.won_count),
    });
  }
  return map;
}

// A Market Mix slice = the active-cohort dimension rows UNIONed with the WON cohort, so a dimension with
// Won value in the period but no active deals CREATED in it (a "won-only" dimension — created earlier,
// won in range) still appears, keeping the per-slice output consistent with the KPI total / quarterly
// panel (Codex P2). Ranked by active volume, then Won value.
function buildMixSlice(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  activeRows: ExecuteRows<any>,
  wonMap: Map<string, WonDimensionEntry>,
  limit: number
): Array<{ name: string; dealCount: number; wonValue: number }> {
  const byKey = new Map<string, { name: string; dealCount: number; wonValue: number }>();
  for (const row of rowsFromExecute<any>(activeRows)) {
    const key = String(row.name ?? "Uncategorized");
    byKey.set(key, { name: key, dealCount: numberFrom(row.deal_count), wonValue: wonMap.get(key)?.wonValue ?? 0 });
  }
  for (const [key, entry] of wonMap) {
    if (!byKey.has(key)) byKey.set(key, { name: key, dealCount: 0, wonValue: entry.wonValue });
  }
  return [...byKey.values()]
    .sort((a, b) => b.dealCount - a.dealCount || b.wonValue - a.wonValue || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((entry) => ({ name: formatLabel(entry.name), dealCount: entry.dealCount, wonValue: entry.wonValue }));
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
    // ACTIVE/open cohort (deal counts, market breadth): created-in-period AND is_active (CC4 — exclude
    // soft-deleted). Won VALUE figures do NOT live in this cohort (see the WON cohort below).
    const where = buildWhere(filters, sql`d.created_at`, { requireActive: true });
    // Created cohort WITHOUT is_active — for the breakdown win-rate counts (wins/losses), which are
    // terminal-outcome counts: archived (is_active=false) terminal deals must stay in the win-rate
    // denominator, consistent with the Executive Trends terminal counts (Codex P2). is_active is applied
    // only to the breakdown's active_deals field below, never its terminal counts.
    const whereNoActive = buildWhere(filters, sql`d.created_at`, { requireActive: false });
    // Quarterly Won value is won-only (psc.slug IN WON below), so window + bucket by the canonical
    // deals.won_closed_date. The old COALESCE(actual_close_date, lost_at, updated_at) counted
    // reseed-contaminated / touched-in-period wins into the wrong quarter.
    const outcomeWhere = buildWonClosedWhere(filters);
    const verticalExpr = sql`COALESCE(NULLIF(c.industry::text, ''), NULLIF(d.project_type, ''), 'Uncategorized')`;
    const regionExpr = sql`COALESCE(NULLIF(c.region, ''), NULLIF(rc.name, ''), NULLIF(p.city, ''), NULLIF(p.state, ''), NULLIF(d.property_city, ''), NULLIF(d.property_state, ''), 'Uncategorized')`;
    const propertyTypeExpr = sql`COALESCE(NULLIF(p.property_type, ''), NULLIF(p.type::text, ''), 'Uncategorized')`;
    const wonValueExpr = aliasedEffectiveWonDealValueSql("d");

    // CC1 — every Won VALUE figure (KPI total, per-vertical/property/region, breakdown won/avg) comes from
    // the WON cohort (canonical won_closed_date window + usable-won-date guard, archived wins included),
    // NOT the created_at-windowed active cohort. By construction this reconciles to quarterlyWonByVertical.
    const [wonVerticalRows, wonPropertyRows, wonRegionRows] = await Promise.all([
      tenantDb.execute(buildWonByDimensionSql(filters, verticalExpr)),
      tenantDb.execute(buildWonByDimensionSql(filters, propertyTypeExpr)),
      tenantDb.execute(buildWonByDimensionSql(filters, regionExpr)),
    ]);
    const wonVerticalMap = wonDimensionMap(wonVerticalRows);
    const wonPropertyMap = wonDimensionMap(wonPropertyRows);
    const wonRegionMap = wonDimensionMap(wonRegionRows);
    // Total Won value === sum over ALL verticals (every won deal buckets into a vertical) === the sum of
    // the quarterly panel. Summed from the un-limited won-by-vertical aggregate (not the LIMIT 12 mix).
    let totalWonValue = 0;
    for (const entry of wonVerticalMap.values()) totalWonValue += entry.wonValue;

    const kpiRows = await tenantDb.execute(sql`
        SELECT
          COUNT(DISTINCT d.id) FILTER (WHERE ${aliasedActiveDealCountFilterSql("d")})::int AS total_deal_count,
          COUNT(DISTINCT ${verticalExpr}) FILTER (WHERE ${aliasedActiveDealCountFilterSql("d")})::int AS active_markets,
          COALESCE((
            SELECT ${regionExpr}
            FROM deals d
            LEFT JOIN companies c ON c.id = d.company_id
            LEFT JOIN properties p ON p.id = d.property_id
            LEFT JOIN region_config rc ON rc.id = d.region_id
            LEFT JOIN users u ON u.id = d.assigned_rep_id
            WHERE ${where}
              AND ${aliasedActiveDealCountFilterSql("d")}
            GROUP BY ${regionExpr}
            ORDER BY COUNT(*) FILTER (WHERE ${aliasedActiveDealCountFilterSql("d")}) DESC
            LIMIT 1
          ), 'Uncategorized') AS most_active_region
        FROM deals d
        LEFT JOIN companies c ON c.id = d.company_id
        LEFT JOIN properties p ON p.id = d.property_id
        LEFT JOIN region_config rc ON rc.id = d.region_id
        LEFT JOIN users u ON u.id = d.assigned_rep_id
        WHERE ${where}
      `);
    const verticalRows = await tenantDb.execute(sql`
        SELECT ${verticalExpr} AS name,
          COUNT(DISTINCT d.id) FILTER (WHERE ${aliasedActiveDealCountFilterSql("d")})::int AS deal_count
        FROM deals d
        LEFT JOIN companies c ON c.id = d.company_id
        LEFT JOIN properties p ON p.id = d.property_id
        LEFT JOIN region_config rc ON rc.id = d.region_id
        LEFT JOIN users u ON u.id = d.assigned_rep_id
        WHERE ${where}
        GROUP BY ${verticalExpr}
        ORDER BY deal_count DESC, name ASC
      `);
    const propertyRows = await tenantDb.execute(sql`
        SELECT ${propertyTypeExpr} AS name,
          COUNT(DISTINCT d.id) FILTER (WHERE ${aliasedActiveDealCountFilterSql("d")})::int AS deal_count
        FROM deals d
        LEFT JOIN companies c ON c.id = d.company_id
        LEFT JOIN properties p ON p.id = d.property_id
        LEFT JOIN region_config rc ON rc.id = d.region_id
        LEFT JOIN users u ON u.id = d.assigned_rep_id
        WHERE ${where}
        GROUP BY ${propertyTypeExpr}
        ORDER BY deal_count DESC, name ASC
      `);
    const regionRows = await tenantDb.execute(sql`
        SELECT ${regionExpr} AS name,
          COUNT(DISTINCT d.id) FILTER (WHERE ${aliasedActiveDealCountFilterSql("d")})::int AS deal_count
        FROM deals d
        LEFT JOIN companies c ON c.id = d.company_id
        LEFT JOIN properties p ON p.id = d.property_id
        LEFT JOIN region_config rc ON rc.id = d.region_id
        LEFT JOIN users u ON u.id = d.assigned_rep_id
        WHERE ${where}
        GROUP BY ${regionExpr}
        ORDER BY deal_count DESC, name ASC
      `);
    const quarterlyRows = await tenantDb.execute(sql`
        SELECT
          CONCAT(EXTRACT(YEAR FROM ${aliasedWonHsClosedWonDateSql("d")})::int, ' Q', EXTRACT(QUARTER FROM ${aliasedWonHsClosedWonDateSql("d")})::int) AS quarter,
          ${verticalExpr} AS vertical,
          COALESCE(SUM(${wonValueExpr}), 0)::numeric AS won_value
        FROM deals d
        LEFT JOIN companies c ON c.id = d.company_id
        LEFT JOIN properties p ON p.id = d.property_id
        LEFT JOIN region_config rc ON rc.id = d.region_id
        LEFT JOIN users u ON u.id = d.assigned_rep_id
        JOIN pipeline_stage_config psc ON psc.id = d.stage_id
        WHERE ${outcomeWhere}
          AND psc.slug IN (${sqlStringList(WON_STAGE_SLUGS)})
          AND ${aliasedHasUsableWonDateSql("d")}
        GROUP BY quarter, ${verticalExpr}
        ORDER BY quarter ASC, won_value DESC
      `);
    // Breakdown: active_deals is the active cohort (is_active); the created-cohort win-rate counts
    // (wins/losses) are terminal-outcome counts that KEEP archived (is_active=false) deals — so the outer
    // scope is whereNoActive and is_active is applied only to active_deals (Codex P2). The Won VALUE
    // columns (wonLastYear, avgDealSize) come from the WON cohort map below.
    const breakdownRows = await tenantDb.execute(sql`
        SELECT ${verticalExpr} AS vertical,
          COUNT(DISTINCT d.id) FILTER (
            WHERE psc.is_terminal = false
              AND d.is_active = true
              AND ${aliasedActiveDealCountFilterSql("d")}
          )::int AS active_deals,
          COUNT(DISTINCT d.id) FILTER (
            WHERE psc.slug IN (${sqlStringList(WON_STAGE_SLUGS)})
              AND ${aliasedActiveDealCountFilterSql("d")}
          )::int AS wins,
          COUNT(DISTINCT d.id) FILTER (
            WHERE psc.slug IN (${sqlStringList(LOST_STAGE_SLUGS)})
              AND ${aliasedActiveDealCountFilterSql("d")}
          )::int AS losses
        FROM deals d
        LEFT JOIN companies c ON c.id = d.company_id
        LEFT JOIN properties p ON p.id = d.property_id
        LEFT JOIN region_config rc ON rc.id = d.region_id
        LEFT JOIN users u ON u.id = d.assigned_rep_id
        LEFT JOIN pipeline_stage_config psc ON psc.id = d.stage_id
        WHERE ${whereNoActive}
        GROUP BY ${verticalExpr}
        ORDER BY active_deals DESC, vertical ASC
      `);

    const kpis = rowsFromExecute<any>(kpiRows)[0] ?? {};

    // Breakdown = active/created-cohort rows (active_deals + created-cohort wins/losses) UNIONed with
    // won-only verticals (Codex P2), so a vertical won in-range but with no active-created deals still
    // shows its Won value. Ranked by active volume, then Won value.
    const breakdownByVertical = new Map<string, { vertical: string; activeDeals: number; wins: number; losses: number }>();
    for (const row of rowsFromExecute<any>(breakdownRows)) {
      const key = String(row.vertical ?? "Uncategorized");
      breakdownByVertical.set(key, {
        vertical: key,
        activeDeals: numberFrom(row.active_deals),
        wins: numberFrom(row.wins),
        losses: numberFrom(row.losses),
      });
    }
    for (const key of wonVerticalMap.keys()) {
      if (!breakdownByVertical.has(key)) breakdownByVertical.set(key, { vertical: key, activeDeals: 0, wins: 0, losses: 0 });
    }
    const breakdown = [...breakdownByVertical.values()]
      .map((entry) => ({ ...entry, won: wonVerticalMap.get(entry.vertical) }))
      .sort((a, b) => b.activeDeals - a.activeDeals || (b.won?.wonValue ?? 0) - (a.won?.wonValue ?? 0) || a.vertical.localeCompare(b.vertical))
      .slice(0, 20)
      .map((entry) => ({
        vertical: formatLabel(entry.vertical),
        activeDeals: entry.activeDeals,
        wonLastYear: entry.won?.wonValue ?? 0,
        winRate: percent(entry.wins, entry.wins + entry.losses),
        avgDealSize: entry.won?.avgWon ?? 0,
      }));

    return {
      kpis: {
        totalDealCount: numberFrom(kpis.total_deal_count),
        totalWonValue,
        activeMarkets: numberFrom(kpis.active_markets),
        mostActiveRegion: formatLabel(kpis.most_active_region),
      },
      verticalMix: buildMixSlice(verticalRows, wonVerticalMap, 12),
      propertyTypeMix: buildMixSlice(propertyRows, wonPropertyMap, 12),
      regionMix: buildMixSlice(regionRows, wonRegionMap, 12),
      quarterlyWonByVertical: rowsFromExecute<any>(quarterlyRows).map((row) => ({
        quarter: String(row.quarter ?? ""),
        vertical: formatLabel(row.vertical),
        wonValue: numberFrom(row.won_value),
      })),
      breakdown,
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
    // ACTIVE/open cohort (active customers, open value, distribution, stale): created-in-period AND
    // is_active (CC4).
    const where = buildWhere(filters, sql`d.created_at`, { requireActive: true });
    const wonValueExpr = aliasedEffectiveWonDealValueSql("d");
    const openValueExpr = aliasedEffectiveDealValueSql("d", aliasedOpenPipelineForecastFirstDealValueSql("d"));

    // CC1 — won lifetime per customer comes from the WON cohort (canonical won_closed_date window +
    // usable-won-date guard, archived wins included), NOT the created_at window. Merged onto the
    // top-customer rows by company_id below.
    const wonByCompanyRows = await tenantDb.execute(sql`
        SELECT d.company_id::text AS company_id,
          COALESCE(SUM(${wonValueExpr}), 0)::numeric AS won_value
        FROM deals d
        LEFT JOIN users u ON u.id = d.assigned_rep_id
        JOIN pipeline_stage_config psc ON psc.id = d.stage_id
        WHERE ${buildWonClosedWhere(filters)}
          AND psc.slug IN (${sqlStringList(WON_STAGE_SLUGS)})
          AND ${aliasedHasUsableWonDateSql("d")}
          AND d.company_id IS NOT NULL
        GROUP BY d.company_id
      `);
    const wonByCompany = new Map<string, number>();
    for (const row of rowsFromExecute<any>(wonByCompanyRows)) {
      wonByCompany.set(String(row.company_id), numberFrom(row.won_value));
    }

    const kpiRows = await tenantDb.execute(sql`
        WITH open_customers AS (
          SELECT d.company_id, SUM(${openValueExpr}) AS open_value
          FROM deals d
          LEFT JOIN users u ON u.id = d.assigned_rep_id
          JOIN pipeline_stage_config psc ON psc.id = d.stage_id
          WHERE ${where}
            AND psc.is_terminal = false
            AND ${aliasedActiveDealCountFilterSql("d")}
            AND d.company_id IS NOT NULL
          GROUP BY d.company_id
        )
        SELECT
          COUNT(*)::int AS total_active_customers,
          COALESCE(SUM(open_value), 0)::numeric AS total_open_value,
          COUNT(*) FILTER (WHERE open_value >= 1000000)::int AS customers_over_one_million_open
        FROM open_customers
      `);
    const customerRows = await tenantDb.execute(sql`
        SELECT
          d.company_id::text AS company_id,
          COALESCE(c.name, 'Unassigned Account') AS company_name,
          COUNT(DISTINCT d.id) FILTER (
            WHERE psc.is_terminal = false
              AND ${aliasedActiveDealCountFilterSql("d")}
          )::int AS active_deals,
          COALESCE(SUM(${openValueExpr}) FILTER (WHERE psc.is_terminal = false), 0)::numeric AS total_open_value,
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
        HAVING COUNT(DISTINCT d.id) FILTER (
          WHERE psc.is_terminal = false
            AND ${aliasedActiveDealCountFilterSql("d")}
        ) > 0
        ORDER BY total_open_value DESC
        LIMIT 20
      `);
    const distributionRows = await tenantDb.execute(sql`
        WITH customer_values AS (
          SELECT d.company_id, SUM(${openValueExpr}) AS open_value
          FROM deals d
          LEFT JOIN users u ON u.id = d.assigned_rep_id
          JOIN pipeline_stage_config psc ON psc.id = d.stage_id
          WHERE ${where}
            AND psc.is_terminal = false
            AND ${aliasedActiveDealCountFilterSql("d")}
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
      `);
    const staleRows = await tenantDb.execute(sql`
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
          AND ${aliasedActiveDealCountFilterSql("d")}
          AND d.company_id IS NOT NULL
        GROUP BY d.company_id, COALESCE(c.name, 'Unassigned Account')
        HAVING FLOOR(EXTRACT(EPOCH FROM (NOW() - MAX(COALESCE(d.last_activity_at, c.last_activity_at, a.last_activity_at, d.updated_at)))) / 86400)::int >= 60
        ORDER BY days_stale DESC, open_value DESC
        LIMIT 20
      `);

    const kpi = rowsFromExecute<any>(kpiRows)[0] ?? {};
    const topCustomers = rowsFromExecute<any>(customerRows).map((row) => ({
      companyId: String(row.company_id),
      companyName: String(row.company_name ?? "Unassigned Account"),
      activeDeals: numberFrom(row.active_deals),
      totalOpenValue: numberFrom(row.total_open_value),
      totalWonLifetime: wonByCompany.get(String(row.company_id)) ?? 0,
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
    const wonValueExpr = aliasedEffectiveWonDealValueSql("d");
    const openValueExpr = aliasedEffectiveDealValueSql("d", aliasedOpenPipelineForecastFirstDealValueSql("d"));
    const previousPeriod = computePreviousPeriod(filters.from, filters.to);
    // Canonical OUTCOME dates: Won = deals.won_closed_date; Lost = lost_at, else updated_at. Won/Lost are
    // classified by the CURRENT stage_id (not deal_stage_history transitions), so a reopened deal counts
    // ONCE — in the period of its canonical outcome date — never once per transition (CC2).
    const wonDate = aliasedWonHsClosedWonDateSql("d");
    const lostDate = sql`COALESCE(d.lost_at, d.updated_at)`;
    // Lost outcome date as a UTC calendar date — the SAME basis the monthly lost bucket uses
    // (TO_CHAR(${lostDate} AT TIME ZONE 'UTC', ...)). Using one UTC basis for BOTH the window and the
    // bucket means the lost window and bucket agree under any session timezone, so the KPI lost count
    // equals the monthly trend's lost sum (the win-rate unification holds on a non-UTC/Central session).
    const lostDateUtc = sql`(${lostDate} AT TIME ZONE 'UTC')::date`;
    const wonSlugs = sqlStringList(WON_STAGE_SLUGS);
    const lostSlugs = sqlStringList(LOST_STAGE_SLUGS);
    const wonInPeriod = (from: SQL, to: SQL) =>
      sql`psc.slug IN (${wonSlugs}) AND ${aliasedHasUsableWonDateSql("d")} AND ${wonDate} >= ${from} AND ${wonDate} <= ${to}`;
    const lostInPeriod = (from: SQL, to: SQL) =>
      sql`psc.slug IN (${lostSlugs}) AND ${lostDateUtc} >= ${from} AND ${lostDateUtc} <= ${to}`;

    // Total Pipeline KPI: open value of deals CREATED in the period (is_active), current + previous.
    const pipelineKpiRows = await tenantDb.execute(sql`
        WITH periods AS (
          SELECT 'current' AS metric, (${filters.from}::date AT TIME ZONE 'UTC') AS from_date, ((${filters.to}::date + INTERVAL '1 day') AT TIME ZONE 'UTC') AS to_date
          UNION ALL
          SELECT 'previous' AS metric, (${previousPeriod.previousFrom}::date AT TIME ZONE 'UTC') AS from_date, (${previousPeriod.previousToExclusive}::date AT TIME ZONE 'UTC') AS to_date
        )
        SELECT
          p.metric,
          COALESCE(SUM(${openValueExpr}) FILTER (WHERE psc.is_terminal = false AND d.is_active = true), 0)::numeric AS total_pipeline
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
      `);
    // UNIFIED OUTCOME KPI (current + previous): Won/Lost by CURRENT stage + canonical outcome date,
    // COUNT(DISTINCT) so a reopened deal counts once. requireActive:false so archived terminal deals
    // count. The KPI Win Rate (won/(won+lost)) is the SAME definition the monthly trend uses, so it
    // equals the trend's period aggregate by construction. Won Revenue/Avg = the won-date cohort (CC1).
    const outcomeKpiRows = await tenantDb.execute(sql`
        WITH periods AS (
          SELECT 'current' AS metric, ${filters.from}::date AS from_date, ${filters.to}::date AS to_date
          UNION ALL
          SELECT 'previous' AS metric, ${previousPeriod.previousFrom}::date AS from_date, (${previousPeriod.previousToExclusive}::date - 1) AS to_date
        )
        SELECT
          p.metric,
          COUNT(DISTINCT d.id) FILTER (WHERE ${wonInPeriod(sql`p.from_date`, sql`p.to_date`)})::int AS won_count,
          COUNT(DISTINCT d.id) FILTER (WHERE ${lostInPeriod(sql`p.from_date`, sql`p.to_date`)})::int AS lost_count,
          COALESCE(SUM(${wonValueExpr}) FILTER (WHERE ${wonInPeriod(sql`p.from_date`, sql`p.to_date`)}), 0)::numeric AS won_revenue,
          COALESCE(AVG(${wonValueExpr}) FILTER (WHERE ${wonInPeriod(sql`p.from_date`, sql`p.to_date`)}), 0)::numeric AS avg_deal_size
        FROM periods p
        JOIN deals d ON (
          (${wonDate} >= p.from_date AND ${wonDate} <= p.to_date)
          OR (${lostDateUtc} >= p.from_date AND ${lostDateUtc} <= p.to_date)
        )
        JOIN pipeline_stage_config psc ON psc.id = d.stage_id
        LEFT JOIN users u ON u.id = d.assigned_rep_id
        WHERE ${buildScopeWhere(filters, { requireActive: false })}
          AND psc.slug IN (${sqlStringList([...WON_STAGE_SLUGS, ...LOST_STAGE_SLUGS])})
        GROUP BY p.metric
      `);
    // Monthly trend: new deals (created month), won (by won_closed_date month, current WON stage,
    // COUNT DISTINCT + won_value), lost (by lost-date month, current LOST stage, COUNT DISTINCT) — all
    // within [from,to] so they sum to the outcome KPI. No deal_stage_history (CC1 + CC2). Active pipeline
    // is the current snapshot (disclosed below).
    const monthlyRows = await tenantDb.execute(sql`
        WITH months AS (
          SELECT TO_CHAR(month_start, 'YYYY-MM') AS month
          FROM generate_series(
            date_trunc('month', (${filters.from}::date AT TIME ZONE 'UTC')),
            date_trunc('month', (${filters.to}::date AT TIME ZONE 'UTC')),
            INTERVAL '1 month'
          ) month_start
        ),
        new_deals AS (
          SELECT TO_CHAR(d.created_at AT TIME ZONE 'UTC', 'YYYY-MM') AS month,
            COUNT(DISTINCT d.id)::int AS new_deals
          FROM deals d
          LEFT JOIN users u ON u.id = d.assigned_rep_id
          WHERE ${where}
          GROUP BY 1
        ),
        won_by_month AS (
          SELECT TO_CHAR(${wonDate}, 'YYYY-MM') AS month,
            COUNT(DISTINCT d.id)::int AS won_deals,
            COALESCE(SUM(${wonValueExpr}), 0)::numeric AS won_value
          FROM deals d
          LEFT JOIN users u ON u.id = d.assigned_rep_id
          JOIN pipeline_stage_config psc ON psc.id = d.stage_id
          WHERE ${buildWonClosedWhere(filters)}
            AND psc.slug IN (${wonSlugs})
            AND ${aliasedHasUsableWonDateSql("d")}
          GROUP BY 1
        ),
        lost_by_month AS (
          SELECT TO_CHAR(${lostDate} AT TIME ZONE 'UTC', 'YYYY-MM') AS month,
            COUNT(DISTINCT d.id)::int AS lost_deals
          FROM deals d
          LEFT JOIN users u ON u.id = d.assigned_rep_id
          JOIN pipeline_stage_config psc ON psc.id = d.stage_id
          WHERE ${buildScopeWhere(filters, { requireActive: false })}
            AND ${lostInPeriod(sql`${filters.from}::date`, sql`${filters.to}::date`)}
          GROUP BY 1
        ),
        current_pipeline AS (
          SELECT COALESCE(SUM(${openValueExpr}), 0)::numeric AS active_pipeline_value
          FROM deals d
          LEFT JOIN users u ON u.id = d.assigned_rep_id
          JOIN pipeline_stage_config psc ON psc.id = d.stage_id
          WHERE ${buildScopeWhere(filters, { requireActive: true })}
            AND psc.is_terminal = false
        )
        SELECT
          months.month,
          COALESCE(new_deals.new_deals, 0)::int AS new_deals,
          COALESCE(won_by_month.won_deals, 0)::int AS won_deals,
          COALESCE(won_by_month.won_value, 0)::numeric AS won_value,
          COALESCE(lost_by_month.lost_deals, 0)::int AS lost_deals,
          current_pipeline.active_pipeline_value
        FROM months
        CROSS JOIN current_pipeline
        LEFT JOIN new_deals ON new_deals.month = months.month
        LEFT JOIN won_by_month ON won_by_month.month = months.month
        LEFT JOIN lost_by_month ON lost_by_month.month = months.month
        ORDER BY months.month ASC
      `);
    // Stage progression IS about movement, so it reads deal_stage_history — but COUNT(DISTINCT deal) so a
    // deal that re-enters a stage counts once (CC2).
    const progressionRows = await tenantDb.execute(sql`
        SELECT
          COALESCE(from_stage.name, 'Initial') AS stage_name,
          COUNT(DISTINCT dsh.deal_id)::int AS entered_count,
          COUNT(DISTINCT dsh.deal_id) FILTER (WHERE to_stage.display_order > COALESCE(from_stage.display_order, -1))::int AS advanced_count
        FROM deal_stage_history dsh
        JOIN deals d ON d.id = dsh.deal_id
        LEFT JOIN users u ON u.id = d.assigned_rep_id
        LEFT JOIN pipeline_stage_config from_stage ON from_stage.id = dsh.from_stage_id
        JOIN pipeline_stage_config to_stage ON to_stage.id = dsh.to_stage_id
        WHERE ${buildWhere(filters, sql`dsh.created_at`)}
        GROUP BY COALESCE(from_stage.name, 'Initial')
        ORDER BY entered_count DESC
      `);

    const pipelinePeriods = rowsFromExecute<any>(pipelineKpiRows);
    const currentPipe = pipelinePeriods.find((row) => row.metric === "current") ?? {};
    const previousPipe = pipelinePeriods.find((row) => row.metric === "previous") ?? {};
    const outcomePeriods = rowsFromExecute<any>(outcomeKpiRows);
    const currentOutcome = outcomePeriods.find((row) => row.metric === "current") ?? {};
    const previousOutcome = outcomePeriods.find((row) => row.metric === "previous") ?? {};
    const metrics = [
      {
        label: "Total Pipeline",
        value: numberFrom(currentPipe.total_pipeline),
        previous: numberFrom(previousPipe.total_pipeline),
        format: "currency" as const,
      },
      {
        label: "Won Revenue",
        value: numberFrom(currentOutcome.won_revenue),
        previous: numberFrom(previousOutcome.won_revenue),
        format: "currency" as const,
      },
      {
        // Single win-rate definition: won/(won+lost) by current stage + outcome date. Equals the period
        // aggregate of the monthly winRateTrend (same predicates).
        label: "Win Rate",
        value: percent(numberFrom(currentOutcome.won_count), numberFrom(currentOutcome.won_count) + numberFrom(currentOutcome.lost_count)),
        previous: percent(numberFrom(previousOutcome.won_count), numberFrom(previousOutcome.won_count) + numberFrom(previousOutcome.lost_count)),
        format: "percent" as const,
      },
      {
        label: "Avg Deal Size",
        value: numberFrom(currentOutcome.avg_deal_size),
        previous: numberFrom(previousOutcome.avg_deal_size),
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
          wonValue: numberFrom(row.won_value),
          lostDeals: numberFrom(row.lost_deals),
          activePipelineValue: numberFrom(row.active_pipeline_value),
        },
      ])
    );
    const months = monthRange(filters.from, filters.to);
    const monthlySeries = months.map(
      (month) => monthlyByKey.get(month) ?? { month, newDeals: 0, wonDeals: 0, wonValue: 0, lostDeals: 0, activePipelineValue: 0 }
    );
    const activePipelineSnapshot = monthlySeries[0]?.activePipelineValue ?? 0;
    // Quarterly comparison = the monthly series rolled up into quarters (same cohorts -> reconciles to the
    // monthly trend and the KPI). Pipeline end = the current snapshot (consistent with the monthly active
    // pipeline; see activePipelineNote).
    const quarterToKey = (month: string) => {
      const [year, monthPart] = month.split("-").map(Number);
      return `${year} Q${Math.floor((monthPart - 1) / 3) + 1}`;
    };
    const quarterMap = new Map<string, { quarter: string; dealsCreated: number; won: number; wonValue: number; lost: number }>();
    for (const m of monthlySeries) {
      const key = quarterToKey(m.month);
      const q = quarterMap.get(key) ?? { quarter: key, dealsCreated: 0, won: 0, wonValue: 0, lost: 0 };
      q.dealsCreated += m.newDeals;
      q.won += m.wonDeals;
      q.wonValue += m.wonValue;
      q.lost += m.lostDeals;
      quarterMap.set(key, q);
    }

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
      monthlyTrends: monthlySeries.map((m) => ({
        month: m.month,
        newDeals: m.newDeals,
        wonDeals: m.wonDeals,
        lostDeals: m.lostDeals,
        activePipelineValue: m.activePipelineValue,
      })),
      activePipelineNote:
        "Active pipeline is a current open-pipeline snapshot repeated across the selected months; historical month-end pipeline snapshots are not available.",
      quarterlyComparison: [...quarterMap.values()].map((q) => ({
        quarter: q.quarter,
        dealsCreated: q.dealsCreated,
        won: q.won,
        lost: q.lost,
        winRate: percent(q.won, q.won + q.lost),
        avgDealSize: q.won ? Math.round(q.wonValue / q.won) : 0,
        pipelineEndValue: activePipelineSnapshot,
      })),
      winRateTrend: monthlySeries.map((m) => ({ month: m.month, winRate: percent(m.wonDeals, m.wonDeals + m.lostDeals) })),
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
