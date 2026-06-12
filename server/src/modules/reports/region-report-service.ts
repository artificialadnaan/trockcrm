// Reports by Region — per-region performance aggregation. Region = deals.region_id → region_config.name,
// else 'Unassigned'. Reuses the CANONICAL bases (do NOT reinvent): Won value = aliasedEffectiveWonDealValueSql
// (awarded-first), Won date = won_closed_date (aliasedWonHsClosedWonDateSql) with the usable-date guard, open
// value = open_best_estimate, Lost = LOST_STAGE_SLUGS on COALESCE(lost_at, actual_close_date, stage_entered_at),
// projection bands/coverage = foundations F2. Won/Lost are windowed by {from,to}; pipeline/forecast/stage-matrix
// are CURRENT snapshots; movers are week-based (getWtdPeriod + prior week). The four region segments (West
// Coast / Central / East Coast / Unassigned) always render and SUM to the office totals (reconciliation).
import { sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@trock-crm/shared/schema";
import {
  aliasedEffectiveWonDealValueSql,
  aliasedActiveDealCountFilterSql,
  aliasedWonHsClosedWonDateSql,
} from "../shared/deal-value-sql.js";
import { dealValueSqlForBasis, projectionBandSql, futureDatedCloseDatePredicateSql } from "./foundations.js";
import { aliasedHasUsableWonDateSql } from "../deals/service.js";
import { WON_STAGE_SLUGS, LOST_STAGE_SLUGS } from "../shared/pipeline-terminal-stages.js";
import { getWtdPeriod, businessToday, shiftBusinessDate } from "../../lib/period.js";

type TenantDb = NodePgDatabase<typeof schema>;

export interface RegionMetricValue {
  value: number;
  count: number;
}
export interface RegionForecastBands {
  "0_30": RegionMetricValue;
  "31_60": RegionMetricValue;
  "61_90": RegionMetricValue;
  beyond_90: RegionMetricValue;
}
export interface RegionTopRep {
  repId: string | null;
  repName: string;
  wonValue: number;
  wonCount: number;
}
export interface RegionRow {
  region: string;
  isUnassigned: boolean;
  displayOrder: number;
  /** WINDOWED by {from,to} on canonical won_closed_date. */
  won: RegionMetricValue;
  /** CURRENT snapshot — open (non-terminal, active) deals' best-estimate value. */
  pipeline: RegionMetricValue;
  /** won / (won + lost) in the window, ×100. null when there were no won+lost outcomes. */
  winRate: number | null;
  /** won value ÷ won count in the window. null when no won deals. */
  avgDeal: number | null;
  /** trailing 8 weekly won values (oldest→newest), for the per-region trend. */
  sparkline: number[];
  /** CURRENT snapshot projection (date-driven on expected_close_date) + honest N/M coverage. */
  forecast: { bands: RegionForecastBands; coverage: { n: number; m: number } };
  /** top reps by won value in the window (a rep can appear in several regions independently). */
  topReps: RegionTopRep[];
}
export interface RegionStageColumn {
  slug: string;
  name: string;
  displayOrder: number;
}
export interface RegionStageCell {
  region: string;
  stageSlug: string;
  count: number;
  value: number;
}
export interface RegionMover {
  region: string;
  deltaWon: number;
}
export interface RegionMoverDeal {
  id: string;
  dealNumber: string | null;
  name: string;
  value: number;
  region: string;
}
export interface RegionReportData {
  period: { from: string; to: string; label: string };
  summary: {
    /** WINDOWED. */
    totalWon: RegionMetricValue;
    /** snapshot. */
    openPipeline: RegionMetricValue;
    /** WINDOWED win rate, ×100. */
    winRate: number | null;
    /** snapshot — share of OPEN deals with no region, ×100. */
    unassignedPct: number | null;
  };
  movers: {
    weekLabel: string;
    biggestRegionMover: RegionMover | null;
    biggestNewDeal: RegionMoverDeal | null;
    biggestWin: RegionMoverDeal | null;
    biggestLoss: RegionMoverDeal | null;
  };
  regions: RegionRow[];
  stageColumns: RegionStageColumn[];
  stageMatrix: RegionStageCell[];
}

export interface RegionReportOptions {
  from: string;
  to: string;
  now?: Date;
  /** top reps per region (default 5). */
  topN?: number;
}

const SPARKLINE_WEEKS = 8;
const UNASSIGNED = "Unassigned";
const UNASSIGNED_ORDER = 9999;

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] })?.rows ?? []) as T[];
}
const n = (v: unknown): number => {
  const num = v == null ? 0 : Number(v);
  return Number.isNaN(num) ? 0 : num;
};

// Defense-in-depth: the route validates from/to, but this is an exported service — never interpolate an
// unvalidated date into the SQL templates below.
function assertIsoDate(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`region report ${label} must be an ISO date (YYYY-MM-DD)`);
}

// CANONICAL fragments. The 'Unassigned' default is a parameterized literal (no sql.raw) so nothing in the
// region expression is ever string-built.
const REGION_NAME = sql`COALESCE(NULLIF(rc.name, ''), ${UNASSIGNED})`;
const REGION_ORDER = sql`COALESCE(rc.display_order, ${UNASSIGNED_ORDER})`;
const wonVal = aliasedEffectiveWonDealValueSql("d");
const openVal = dealValueSqlForBasis("d", "open_best_estimate");
const wonDate = aliasedWonHsClosedWonDateSql("d"); // d.won_closed_date (DATE)
const lostDate = sql`COALESCE(d.lost_at, d.actual_close_date::timestamptz, d.stage_entered_at)`;
const reportable = sql`${aliasedActiveDealCountFilterSql("d")} AND COALESCE(d.is_test_data, false) = false`;
const COMMON_JOINS = sql`
  FROM deals d
  JOIN pipeline_stage_config psc ON psc.id = d.stage_id
  LEFT JOIN region_config rc ON rc.id = d.region_id
  LEFT JOIN users u ON u.id = d.assigned_rep_id`;
// Only for trusted, hardcoded stage-slug constants (WON_STAGE_SLUGS / LOST_STAGE_SLUGS). Each slug is
// parameterized, but never call this with user input.
const slugList = (slugs: readonly string[]) => sql.join(slugs.map((s) => sql`${s}`), sql`, `);
const TERMINAL_SLUGS = [...WON_STAGE_SLUGS, ...LOST_STAGE_SLUGS];
const wonInWindow = (from: string, to: string): SQL =>
  sql`psc.slug IN (${slugList(WON_STAGE_SLUGS)}) AND ${aliasedHasUsableWonDateSql("d")} AND ${wonDate} >= ${from}::date AND ${wonDate} <= ${to}::date`;
const lostInWindow = (from: string, to: string): SQL =>
  sql`psc.slug IN (${slugList(LOST_STAGE_SLUGS)}) AND (${lostDate})::date >= ${from}::date AND (${lostDate})::date <= ${to}::date`;
const OPEN_PREDICATE = sql`d.is_active = true AND psc.is_terminal = false`;

const pct = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

export async function getRegionReport(tenantDb: TenantDb, options: RegionReportOptions): Promise<RegionReportData> {
  const { from, to } = options;
  assertIsoDate(from, "from");
  assertIsoDate(to, "to");
  const now = options.now ?? new Date();
  const topN = options.topN ?? 5;
  const today = businessToday(now);
  const week = getWtdPeriod("to_date", now);
  const prior = { from: shiftBusinessDate(week.from, -7), to: shiftBusinessDate(week.from, -1) };
  const band = (b: string) => sql`(${projectionBandSql("d.expected_close_date", today)}) = ${b}`;
  const futureDated = futureDatedCloseDatePredicateSql("d.expected_close_date", today);

  // ---- canonical region list (active regions + Unassigned), so all four segments always render ----
  const activeRegions = rowsFromExecute<{ name: string; display_order: number }>(
    await tenantDb.execute(
      sql`SELECT name, display_order FROM region_config WHERE is_active = true ORDER BY display_order, name`
    )
  );

  // ---- 1) per-region won/lost (windowed) ----
  const terminalRows = rowsFromExecute<{
    region: string;
    region_order: number;
    won_value: string;
    won_count: number;
    lost_count: number;
  }>(
    await tenantDb.execute(sql`
      SELECT ${REGION_NAME} AS region, ${REGION_ORDER} AS region_order,
        COALESCE(SUM(${wonVal}) FILTER (WHERE ${wonInWindow(from, to)}), 0) AS won_value,
        COUNT(*) FILTER (WHERE ${wonInWindow(from, to)})::int AS won_count,
        COUNT(*) FILTER (WHERE ${lostInWindow(from, to)})::int AS lost_count
      ${COMMON_JOINS}
      WHERE ${reportable} AND psc.slug IN (${slugList(TERMINAL_SLUGS)})
      GROUP BY 1, 2`)
  );

  // ---- 2) per-region open snapshot (pipeline + forecast bands + N/M coverage) ----
  // FUTURE (probability-weighting): the forecast is date-driven (NOT probability-weighted) because
  // win_probability is ~1% filled today. When it fills, weight each band's $ by swapping the band value
  // expression below from `SUM(${openVal})` to `SUM(${openVal} * COALESCE(d.win_probability,0) / 100.0)`
  // (gated on win-prob fill). The N/M coverage + bucketing stay as-is; only the value aggregate changes.
  const openRows = rowsFromExecute<{
    region: string;
    region_order: number;
    open_value: string;
    open_count: number;
    n: number;
    b0c: number; b0v: string; b1c: number; b1v: string; b2c: number; b2v: string; b3c: number; b3v: string;
  }>(
    await tenantDb.execute(sql`
      SELECT ${REGION_NAME} AS region, ${REGION_ORDER} AS region_order,
        COALESCE(SUM(${openVal}), 0) AS open_value,
        COUNT(*)::int AS open_count,
        COUNT(*) FILTER (WHERE ${futureDated})::int AS n,
        COUNT(*) FILTER (WHERE ${band("0_30")})::int AS b0c, COALESCE(SUM(${openVal}) FILTER (WHERE ${band("0_30")}),0) AS b0v,
        COUNT(*) FILTER (WHERE ${band("31_60")})::int AS b1c, COALESCE(SUM(${openVal}) FILTER (WHERE ${band("31_60")}),0) AS b1v,
        COUNT(*) FILTER (WHERE ${band("61_90")})::int AS b2c, COALESCE(SUM(${openVal}) FILTER (WHERE ${band("61_90")}),0) AS b2v,
        COUNT(*) FILTER (WHERE ${band("beyond_90")})::int AS b3c, COALESCE(SUM(${openVal}) FILTER (WHERE ${band("beyond_90")}),0) AS b3v
      ${COMMON_JOINS}
      WHERE ${reportable} AND ${OPEN_PREDICATE}
      GROUP BY 1, 2`)
  );

  // ---- 3) per-region × stage (snapshot open) ----
  const stageRows = rowsFromExecute<{
    region: string;
    stage_slug: string;
    stage_name: string;
    stage_order: number;
    cnt: number;
    val: string;
  }>(
    await tenantDb.execute(sql`
      SELECT ${REGION_NAME} AS region, psc.slug AS stage_slug, psc.name AS stage_name,
        psc.display_order AS stage_order, COUNT(*)::int AS cnt, COALESCE(SUM(${openVal}),0) AS val
      ${COMMON_JOINS}
      WHERE ${reportable} AND ${OPEN_PREDICATE}
      GROUP BY 1, 2, 3, 4`)
  );

  // ---- 4) per-region × rep (windowed won) ----
  const repRows = rowsFromExecute<{
    region: string;
    rep_id: string | null;
    rep_name: string;
    won_value: string;
    won_count: number;
  }>(
    await tenantDb.execute(sql`
      SELECT ${REGION_NAME} AS region, d.assigned_rep_id AS rep_id, COALESCE(u.display_name,'') AS rep_name,
        COALESCE(SUM(${wonVal}),0) AS won_value, COUNT(*)::int AS won_count
      ${COMMON_JOINS}
      WHERE ${reportable} AND ${wonInWindow(from, to)}
      GROUP BY 1, 2, 3
      ORDER BY won_value DESC`)
  );

  // ---- 5) per-region × week (trailing sparkline) ----
  const weekStarts = Array.from({ length: SPARKLINE_WEEKS }, (_, i) =>
    shiftBusinessDate(week.from, -7 * (SPARKLINE_WEEKS - 1 - i))
  );
  const sparkFrom = weekStarts[0];
  const sparkTo = shiftBusinessDate(week.from, 6); // Saturday of the current week
  // won_closed_date is a DATE — bucket to its Sunday week-start directly (DOW 0 = Sunday). Do NOT apply
  // AT TIME ZONE here: casting a midnight-UTC date to Chicago rolls it back a day into the prior week.
  const weekBucket = sql`(d.won_closed_date - EXTRACT(DOW FROM d.won_closed_date)::int)`;
  const sparkRows = rowsFromExecute<{ region: string; wk: string; val: string }>(
    await tenantDb.execute(sql`
      SELECT ${REGION_NAME} AS region, ${weekBucket} AS wk, COALESCE(SUM(${wonVal}),0) AS val
      ${COMMON_JOINS}
      WHERE ${reportable} AND psc.slug IN (${slugList(WON_STAGE_SLUGS)}) AND ${aliasedHasUsableWonDateSql("d")}
        AND ${wonDate} >= ${sparkFrom}::date AND ${wonDate} <= ${sparkTo}::date
      GROUP BY 1, 2`)
  );

  // ---- 6) movers (week-based) ----
  const moverRows = rowsFromExecute<{ region: string; this_won: string; prior_won: string }>(
    await tenantDb.execute(sql`
      SELECT ${REGION_NAME} AS region,
        COALESCE(SUM(${wonVal}) FILTER (WHERE ${wonInWindow(week.from, week.to)}),0) AS this_won,
        COALESCE(SUM(${wonVal}) FILTER (WHERE ${wonInWindow(prior.from, prior.to)}),0) AS prior_won
      ${COMMON_JOINS}
      WHERE ${reportable} AND psc.slug IN (${slugList(WON_STAGE_SLUGS)}) AND ${aliasedHasUsableWonDateSql("d")}
      GROUP BY 1`)
  );
  const biggestNewDeal = await topMoverDeal(
    tenantDb,
    sql`${reportable} AND ${OPEN_PREDICATE} AND d.created_at >= ${week.from}::date AND d.created_at < (${week.to}::date + 1)`,
    openVal
  );
  const biggestWin = await topMoverDeal(tenantDb, sql`${reportable} AND ${wonInWindow(week.from, week.to)}`, wonVal);
  const biggestLoss = await topMoverDeal(tenantDb, sql`${reportable} AND ${lostInWindow(week.from, week.to)}`, wonVal);

  // ---------- assemble ----------
  const repsByRegion = new Map<string, RegionTopRep[]>();
  for (const row of repRows) {
    const list = repsByRegion.get(row.region) ?? [];
    if (list.length < topN)
      list.push({ repId: row.rep_id, repName: row.rep_name || "Unassigned rep", wonValue: n(row.won_value), wonCount: n(row.won_count) });
    repsByRegion.set(row.region, list);
  }
  const sparkByRegion = new Map<string, Map<string, number>>();
  for (const row of sparkRows) {
    const m = sparkByRegion.get(row.region) ?? new Map<string, number>();
    m.set(String(row.wk).slice(0, 10), n(row.val));
    sparkByRegion.set(row.region, m);
  }
  const terminalByRegion = new Map(terminalRows.map((r) => [r.region, r]));
  const openByRegion = new Map(openRows.map((r) => [r.region, r]));

  // canonical region order: active regions, then the synthetic Unassigned bucket, then any stray region from
  // the data. Skip blank-named or literally-"Unassigned" config rows + dedupe so the synthetic bucket is the
  // ONLY Unassigned and no name collides (REGION_NAME already folds blank/null rc.name into 'Unassigned').
  const orderedNames: Array<{ region: string; order: number }> = [];
  const known = new Set<string>();
  for (const rg of activeRegions) {
    const name = (rg.name ?? "").trim();
    if (!name || name.toLowerCase() === UNASSIGNED.toLowerCase() || known.has(name)) continue;
    known.add(name);
    orderedNames.push({ region: name, order: n(rg.display_order) });
  }
  orderedNames.push({ region: UNASSIGNED, order: UNASSIGNED_ORDER });
  known.add(UNASSIGNED);
  for (const r of [...terminalRows, ...openRows]) {
    if (!known.has(r.region)) {
      known.add(r.region);
      orderedNames.push({ region: r.region, order: n(r.region_order) });
    }
  }
  orderedNames.sort((a, b) => a.order - b.order || a.region.localeCompare(b.region));

  const regions: RegionRow[] = orderedNames.map(({ region, order }) => {
    const t = terminalByRegion.get(region);
    const o = openByRegion.get(region);
    const wonCount = n(t?.won_count);
    const lostCount = n(t?.lost_count);
    const wonValue = n(t?.won_value);
    const spark = sparkByRegion.get(region);
    return {
      region,
      isUnassigned: region === UNASSIGNED,
      displayOrder: order,
      won: { value: wonValue, count: wonCount },
      pipeline: { value: n(o?.open_value), count: n(o?.open_count) },
      winRate: pct(wonCount, wonCount + lostCount),
      avgDeal: wonCount > 0 ? Math.round(wonValue / wonCount) : null,
      sparkline: weekStarts.map((w) => spark?.get(w) ?? 0),
      forecast: {
        bands: {
          "0_30": { count: n(o?.b0c), value: n(o?.b0v) },
          "31_60": { count: n(o?.b1c), value: n(o?.b1v) },
          "61_90": { count: n(o?.b2c), value: n(o?.b2v) },
          beyond_90: { count: n(o?.b3c), value: n(o?.b3v) },
        },
        coverage: { n: n(o?.n), m: n(o?.open_count) },
      },
      topReps: repsByRegion.get(region) ?? [],
    };
  });

  // stage columns (distinct open stages, ordered) + cells
  const colMap = new Map<string, RegionStageColumn>();
  const stageMatrix: RegionStageCell[] = [];
  for (const row of stageRows) {
    colMap.set(row.stage_slug, { slug: row.stage_slug, name: row.stage_name, displayOrder: n(row.stage_order) });
    stageMatrix.push({ region: row.region, stageSlug: row.stage_slug, count: n(row.cnt), value: n(row.val) });
  }
  const stageColumns = [...colMap.values()].sort((a, b) => a.displayOrder - b.displayOrder || a.slug.localeCompare(b.slug));

  // office summary (reconciles to the region rows by construction)
  const totalWonValue = regions.reduce((s, r) => s + r.won.value, 0);
  const totalWonCount = regions.reduce((s, r) => s + r.won.count, 0);
  const totalLostCount = terminalRows.reduce((s, r) => s + n(r.lost_count), 0);
  const totalOpenValue = regions.reduce((s, r) => s + r.pipeline.value, 0);
  const totalOpenCount = regions.reduce((s, r) => s + r.pipeline.count, 0);
  const unassignedOpen = regions.find((r) => r.isUnassigned)?.pipeline.count ?? 0;

  // biggest region mover (largest absolute Δ won, this week vs prior week). Deterministic tie-break by
  // region name so equal-magnitude movers don't flip between runs.
  const movers = moverRows
    .map((row) => ({ region: row.region, deltaWon: n(row.this_won) - n(row.prior_won) }))
    .filter((m) => m.deltaWon !== 0)
    .sort((a, b) => Math.abs(b.deltaWon) - Math.abs(a.deltaWon) || a.region.localeCompare(b.region));
  const biggestRegionMover: RegionMover | null = movers[0] ?? null;

  return {
    period: { from, to, label: `${from} → ${to}` },
    summary: {
      totalWon: { value: totalWonValue, count: totalWonCount },
      openPipeline: { value: totalOpenValue, count: totalOpenCount },
      winRate: pct(totalWonCount, totalWonCount + totalLostCount),
      unassignedPct: pct(unassignedOpen, totalOpenCount),
    },
    movers: { weekLabel: `${week.from} → ${week.to}`, biggestRegionMover, biggestNewDeal, biggestWin, biggestLoss },
    regions,
    stageColumns,
    stageMatrix,
  };
}

async function topMoverDeal(tenantDb: TenantDb, whereSql: SQL, valueSql: SQL): Promise<RegionMoverDeal | null> {
  const rows = rowsFromExecute<{ id: string; deal_number: string | null; name: string; region: string; val: string }>(
    await tenantDb.execute(sql`
      SELECT d.id AS id, d.deal_number AS deal_number, d.name AS name, ${REGION_NAME} AS region, ${valueSql} AS val
      ${COMMON_JOINS}
      WHERE ${whereSql}
      ORDER BY val DESC NULLS LAST, d.created_at DESC, d.id DESC
      LIMIT 1`)
  );
  const row = rows[0];
  if (!row) return null;
  return { id: String(row.id), dealNumber: row.deal_number == null ? null : String(row.deal_number), name: row.name, value: n(row.val), region: row.region };
}
