import { sql, type SQL } from "drizzle-orm";
import {
  reportableDealSqlPredicate,
  effectiveOnHoldSqlPredicate,
  closeTargetFarOutSqlPredicate,
} from "@trock-crm/shared/types";
import { TERMINAL_STAGE_SLUGS } from "./pipeline-terminal-stages.js";

type DealValueTable = {
  onHold: unknown;
  awardedAmount: unknown;
  bidBoardTotalSales?: unknown;
  bidEstimate: unknown;
  ddEstimate: unknown;
  forecastRevenue?: unknown;
};

type DealValueColumn =
  | "forecast_revenue"
  | "bid_board_total_sales"
  | "bid_estimate"
  | "dd_estimate"
  | "awarded_amount";

// DEFAULT deal-value priority chain (awarded-first): awarded_amount > bid_board_total_sales > bid_estimate
// > dd_estimate. Used by every stage EXCEPT the single 'estimating' stage, which overrides DD ABOVE bid
// (ESTIMATING_VALUE_CHAIN below; 2026-06-18). Won and every other open stage share THIS one chain (no
// parallel won-vs-open logic). Each candidate is gated `> 0` (positiveDealValueCandidateSql), so BOTH 0
// and NULL fall through to the next candidate; the chain's final fallback is 0.
//
// CONVENTION SHIFT (2026-06-18, "editable DD + awarded-highest" decision): the open/estimating basis was
// formerly bid-first with awarded LAST (and distinct from the Won basis). It was flipped to awarded-first
// after verifying the change is INERT on prod REPORTABLE totals ($0 delta — only 2 open deals carry an
// awarded amount and both already equal their bid). The flip also makes lost/terminal deals awarded-first;
// that touches only 13 non-reportable lost/inactive CARD displays (never summed in any bucket total).
// dealBestEstimateSql and dealAwardedFirstWithFallbackSql are retained as separate names (many call sites)
// but now both resolve through this one chain.
const DEAL_VALUE_PRIORITY_CHAIN = [
  "awarded_amount",
  "bid_board_total_sales",
  "bid_estimate",
  "dd_estimate",
] as const satisfies readonly DealValueColumn[];

const FORECAST_FIRST_VALUE_CHAIN = [
  "forecast_revenue",
  ...DEAL_VALUE_PRIORITY_CHAIN,
] as const satisfies readonly DealValueColumn[];

// STAGE-AWARE override for the single 'estimating' stage (2026-06-18, Adnaan): during estimating the
// bid is in-progress/incomplete, so DD outranks bid — awarded > dd_estimate > bid_board_total_sales >
// bid_estimate. Awarded still wins; bid is NOT skipped, just outranked when DD exists (a bid-only
// estimating deal keeps its bid, never $0). Applies ONLY to the canonical 'estimating' stage (route-aware:
// includes the legacy estimate_in_progress alias, excludes service_estimating). Same `> 0` gating +
// on-hold-zeroing as the default chain.
//
// SCOPE (Adnaan, 2026-06-19, re Codex P2): this DD-over-bid rule is applied ONLY on the DEALS pipeline value
// paths — the kanban/stage-workspace per-column totals (pipelineValueSourceForStageSlug) and the deals-list
// filter/sort/total + stage drill (aliasedStageAwareEffectiveDealValueSql), mirrored by the TS card resolvers
// (getRawDealValue / resolveBestEstimate). Dashboard + reports value aggregates DELIBERATELY keep the default
// open chain (deal-value-sql default + reports foundations bases), so an estimating deal can read DD-first on
// the deals board and bid-first in a report. Verified ~inert on prod (only ~2 estimating deals have bid != DD).
// Extending platform-wide is a deliberate follow-up, NOT an accidental gap.
const ESTIMATING_VALUE_CHAIN = [
  "awarded_amount",
  "dd_estimate",
  "bid_board_total_sales",
  "bid_estimate",
] as const satisfies readonly DealValueColumn[];

export function positiveDealValueCandidateSql(value: unknown): SQL {
  return sql`CASE WHEN ${value} > 0 THEN ${value} END`;
}

function aliasedPositiveDealValueCandidateSql(alias: string, column: string): string {
  return `CASE WHEN ${alias}.${column} > 0 THEN ${alias}.${column} END`;
}

function tableColumnSql(table: DealValueTable, column: DealValueColumn): unknown {
  switch (column) {
    case "forecast_revenue":
      return table.forecastRevenue ?? sql`NULL`;
    case "bid_board_total_sales":
      return table.bidBoardTotalSales ?? sql`NULL`;
    case "bid_estimate":
      return table.bidEstimate;
    case "dd_estimate":
      return table.ddEstimate;
    case "awarded_amount":
      return table.awardedAmount;
  }
}

function dealValueChainSql(table: DealValueTable, columns: readonly DealValueColumn[]): SQL {
  return sql`COALESCE(${sql.join(
    columns.map((column) => positiveDealValueCandidateSql(tableColumnSql(table, column))),
    sql`, `
  )}, 0)`;
}

function aliasedDealValueChainSql(alias: string, columns: readonly DealValueColumn[]): SQL {
  return sql.raw(
    `COALESCE(${columns
      .map((column) => aliasedPositiveDealValueCandidateSql(alias, column))
      .join(", ")}, 0)`
  );
}

export function dealBestEstimateSql(table: DealValueTable): SQL {
  return dealValueChainSql(table, DEAL_VALUE_PRIORITY_CHAIN);
}

// 'estimating' stage only: DD outranks bid (awarded > dd > bid_board > bid). See ESTIMATING_VALUE_CHAIN.
export function dealEstimatingValueSql(table: DealValueTable): SQL {
  return dealValueChainSql(table, ESTIMATING_VALUE_CHAIN);
}

export function dealAwardedAmountSql(table: DealValueTable): SQL {
  return sql`COALESCE(${positiveDealValueCandidateSql(table.awardedAmount)}, 0)`;
}

export function dealAwardedFirstWithFallbackSql(table: DealValueTable): SQL {
  return dealValueChainSql(table, DEAL_VALUE_PRIORITY_CHAIN);
}

export function dealBestEstimateWithForecastSql(table: DealValueTable): SQL {
  return dealValueChainSql(table, FORECAST_FIRST_VALUE_CHAIN);
}

// OPEN-pipeline value-zeroing keys on EFFECTIVE hold = stored on_hold OR a close target past the 90-day
// horizon, so a far-out OPEN deal contributes $0 to pipeline/forecast just like a parked one. Same
// boundary as the On Hold filter (shared CLOSE_TARGET_HOLD_HORIZON_DAYS + the America/Chicago anchor) so
// the two can't disagree. (The reportable/count predicate is intentionally unchanged — a far-out deal is
// $0 but still counted.) The far-future auto-park leg lives ONLY in the ALIASED form
// (aliasedEffectiveDealValueSql), which runs against OPEN-filtered report populations. The COLUMN form is
// stored-on_hold ONLY: its sole consumer is the property linked-value SUM, which runs over MIXED (open +
// won) linked deals with no terminal filter, so applying the horizon here would wrongly zero realized
// won revenue. (A drizzle table can't be cheaply stage-filtered; the aliased report queries already
// exclude terminal deals, so they carry the auto-park leg safely.)
export function effectiveDealValueSql(table: DealValueTable, rawValueSql: SQL = dealBestEstimateSql(table)): SQL {
  return storedOnHoldDealValueSql(table, rawValueSql);
}

// REALIZED-safe value-zeroing: stored on_hold ONLY. A won/awarded value is never auto-parked by a stale
// forecast date — a deal can be won EARLY while its expected_close_date is still far out (the won path
// stamps the won date but does NOT clear the forecast), and zeroing that realized revenue would silently
// drop it from won/commission/report totals. Mirrors the client's won-aware getEffectiveDealValue.
function storedOnHoldDealValueSql(table: DealValueTable, rawValueSql: SQL): SQL {
  return sql`CASE WHEN COALESCE(${table.onHold}, false) THEN 0 ELSE COALESCE(${rawValueSql}, 0) END`;
}

export function effectiveAwardedDealValueSql(
  table: DealValueTable,
  rawValueSql: SQL = dealAwardedAmountSql(table)
): SQL {
  return storedOnHoldDealValueSql(table, rawValueSql);
}

export function effectiveWonDealValueSql(table: DealValueTable): SQL {
  return storedOnHoldDealValueSql(table, dealAwardedFirstWithFallbackSql(table));
}

export function effectiveEstimatingDealValueSql(table: DealValueTable): SQL {
  return effectiveDealValueSql(table, dealEstimatingValueSql(table));
}

export function aliasedDealBestEstimateSql(alias: string): SQL {
  return aliasedDealValueChainSql(alias, DEAL_VALUE_PRIORITY_CHAIN);
}

// 'estimating' stage only: DD outranks bid (awarded > dd > bid_board > bid). See ESTIMATING_VALUE_CHAIN.
export function aliasedDealEstimatingValueSql(alias: string): SQL {
  return aliasedDealValueChainSql(alias, ESTIMATING_VALUE_CHAIN);
}

export function aliasedDealAwardedAmountSql(alias: string): SQL {
  return sql.raw(`COALESCE(${aliasedPositiveDealValueCandidateSql(alias, "awarded_amount")}, 0)`);
}

export function aliasedDealAwardedFirstWithFallbackSql(alias: string): SQL {
  return aliasedDealValueChainSql(alias, DEAL_VALUE_PRIORITY_CHAIN);
}

export function aliasedDealBestEstimateWithForecastSql(alias: string): SQL {
  return aliasedDealValueChainSql(alias, FORECAST_FIRST_VALUE_CHAIN);
}

export function aliasedForecastFirstDealValueSql(alias: string): SQL {
  return aliasedDealValueChainSql(alias, FORECAST_FIRST_VALUE_CHAIN);
}

export function aliasedOpenPipelineForecastFirstDealValueSql(alias: string): SQL {
  return aliasedDealValueChainSql(alias, FORECAST_FIRST_VALUE_CHAIN);
}

// Aliased twin of effectiveDealValueSql (OPEN/best-estimate value). Reuses the SHARED
// effectiveOnHoldSqlPredicate so the value-zero test is byte-identical to the On Hold filter — they
// cannot drift. NOT for won-value (see aliasedEffectiveWonDealValueSql).
export function aliasedEffectiveDealValueSql(
  alias: string,
  rawValueSql: SQL = aliasedDealBestEstimateSql(alias)
): SQL {
  return sql`CASE WHEN ${sql.raw(effectiveOnHoldSqlPredicate(alias))} THEN 0 ELSE COALESCE(${rawValueSql}, 0) END`;
}

// Aliased twin of storedOnHoldDealValueSql — REALIZED-safe (stored on_hold ONLY), for won/awarded value.
function aliasedStoredOnHoldDealValueSql(alias: string, rawValueSql: SQL): SQL {
  return sql`CASE WHEN COALESCE(${sql.raw(`${alias}.on_hold`)}, false) THEN 0 ELSE COALESCE(${rawValueSql}, 0) END`;
}

export function aliasedEffectiveAwardedDealValueSql(
  alias: string,
  rawValueSql: SQL = aliasedDealAwardedAmountSql(alias)
): SQL {
  return aliasedStoredOnHoldDealValueSql(alias, rawValueSql);
}

// Effective deal value for a MIXED (open + terminal) population where stage classification is available as a
// raw SQL boolean (e.g. a joined pipeline_stage_config.slug + the Bid Board mirror) rather than resolved
// stage-id sets. A terminal (won/lost) row is realized/preserved -> zeroed on stored on_hold ONLY; an OPEN
// row additionally auto-parks a far-out close target. Use on aggregates that sum across outcomes without a
// per-stage CASE (company stats, etc.) so far-out terminal value is never wrongly dropped (Codex P2).
export function aliasedTerminalAwareEffectiveDealValueSql(
  alias: string,
  rawValueSql: SQL,
  isTerminalSql: SQL
): SQL {
  return sql`CASE WHEN ${isTerminalSql} THEN ${aliasedStoredOnHoldDealValueSql(
    alias,
    rawValueSql
  )} ELSE ${aliasedEffectiveDealValueSql(alias, rawValueSql)} END`;
}

// The canonical "is this row a realized terminal (won/lost) deal" SQL boolean for a MIXED population, used to
// drive aliasedTerminalAwareEffectiveDealValueSql. Mirrors the client/on-hold-predicate terminal exemption:
// the CRM stage slug is won/lost (via a joined pipeline_stage_config) OR the Bid Board mirror is terminal (a
// BB-owned deal can be terminal in bid_board_stage_slug while its CRM stage is still open). `stageSlugColumn`
// is the joined slug expression (e.g. "psc.slug"); `dealAlias` qualifies bid_board_stage_slug. Both are
// trusted developer literals, never user input.
export function aliasedTerminalDealBySlugSql(dealAlias: string, stageSlugColumn: string): SQL {
  const terminalSlugs = sql.join(TERMINAL_STAGE_SLUGS.map((slug) => sql`${slug}`), sql`, `);
  return sql`(${sql.raw(stageSlugColumn)} IN (${terminalSlugs}) OR COALESCE(${sql.raw(
    `${dealAlias}.bid_board_stage_slug`
  )}, '') IN (${terminalSlugs}))`;
}

// The Bid Board MIRROR terminal signal alone: true when a deal is won/lost in bid_board_stage_slug. Use on a
// population already constrained to a single OPEN CRM stage (a stage page) or filtered CRM-non-terminal,
// where the only remaining terminal exposure is a BB-owned deal whose mirror is terminal while its CRM stage
// is still open. Returns a raw SQL string fragment so worker raw-SQL callers can reuse it.
export function bidBoardTerminalSqlPredicate(dealAlias: string): string {
  const slugs = TERMINAL_STAGE_SLUGS.map((slug) => `'${slug.replace(/'/g, "''")}'`).join(", ");
  return `COALESCE(${dealAlias}.bid_board_stage_slug, '') IN (${slugs})`;
}

export function aliasedBidBoardTerminalSql(dealAlias: string): SQL {
  return sql.raw(`(${bidBoardTerminalSqlPredicate(dealAlias)})`);
}

export function aliasedEffectiveWonDealValueSql(alias: string): SQL {
  return aliasedStoredOnHoldDealValueSql(alias, aliasedDealAwardedFirstWithFallbackSql(alias));
}

// Aliased twin for a LOST terminal deal — REALIZED/PRESERVED value, zeroed on stored on_hold ONLY. A lost
// bid is a historical record whose value is kept for Loss Analysis, so it is NEVER auto-parked by a stale
// far-out forecast date (only its stored flag zeros it). Mirrors the client getEffectiveDealValue's
// terminal (won OR lost) exemption and the won twin above; uses the same unified awarded-first chain.
export function aliasedEffectiveLostDealValueSql(alias: string): SQL {
  return aliasedStoredOnHoldDealValueSql(alias, aliasedDealAwardedFirstWithFallbackSql(alias));
}

// TERMINAL-AWARE effective-on-hold SQL condition — the SQL twin of the shared TS isDealEffectivelyOnHold.
// A deal is effectively on hold when the stored `on_hold` flag is set OR — for an OPEN (non-terminal) deal
// — its close target is more than CLOSE_TARGET_HOLD_HORIZON_DAYS out. A won/lost deal is realized/preserved,
// so the far-out auto-park leg NEVER applies to it (only its stored flag holds it); `terminalStageIds`
// (won ∪ lost) gates that leg via `stage_id NOT IN (...)`. Pass `[]` for the legacy open-only predicate
// (a population with no terminal rows). Reuses the SHARED far-out day-math so SQL and TS can't drift, and
// the shared identifier validation (closeTargetFarOutSqlPredicate throws on an invalid path before any raw
// column string is built here).
export function aliasedEffectiveOnHoldConditionSql(
  identifierPath = "deals",
  terminalStageIds: string[] = []
): SQL {
  const farOut = sql.raw(closeTargetFarOutSqlPredicate(identifierPath));
  const onHoldColumn = identifierPath ? `${identifierPath}.on_hold` : "on_hold";
  const stored = sql.raw(`COALESCE(${onHoldColumn}, false) = true`);
  // Two INDEPENDENT terminal signals gate the far-out auto-park leg, mirroring the client
  // isDealValueEffectivelyOnHold: (1) the CRM stage_id is won/lost (caller-resolved ids), and (2) the Bid
  // Board mirror is terminal — a BB-owned deal can be won/lost in bid_board_stage_slug while its CRM stage_id
  // is still open. Either makes the deal realized/preserved, so the stale forecast date must NOT auto-park it.
  const guards: SQL[] = [];
  if (terminalStageIds.length > 0) {
    const stageIdColumn = sql.raw(`${identifierPath}.stage_id`);
    guards.push(
      sql`${stageIdColumn} NOT IN (${sql.join(terminalStageIds.map((id) => sql`${id}`), sql`, `)})`
    );
  }
  const bidBoardStageSlug = sql.raw(`COALESCE(${identifierPath}.bid_board_stage_slug, '')`);
  guards.push(
    sql`${bidBoardStageSlug} NOT IN (${sql.join(TERMINAL_STAGE_SLUGS.map((slug) => sql`${slug}`), sql`, `)})`
  );
  const farOutForOpen = sql`${sql.join(guards, sql` AND `)} AND (${farOut})`;
  return sql`(${stored} OR (${farOutForOpen}))`;
}

export function aliasedEffectiveEstimatingDealValueSql(alias: string): SQL {
  return aliasedEffectiveDealValueSql(alias, aliasedDealEstimatingValueSql(alias));
}

export function reportableDealFilterSql(identifierPath?: string): SQL {
  return sql.raw(reportableDealSqlPredicate(identifierPath));
}

export function aliasedReportableDealFilterSql(alias: string): SQL {
  return reportableDealFilterSql(alias);
}

export function aliasedActiveDealCountFilterSql(alias: string): SQL {
  return aliasedReportableDealFilterSql(alias);
}

/**
 * Two-tier sort key: 0 for active, non-zero deals (sorted on top), 1 for on-hold
 * or $0-value deals (pushed to the bottom of the list/column). Use as the LEADING
 * `ORDER BY` key, ascending, ahead of the surface's existing sort. `valueSql` should
 * be the SAME value expression the surface displays/counts so the tier matches what
 * users see. (Effective-value chains already zero on-hold, but the explicit
 * reportable guard keeps the intent clear and also covers raw value chains.)
 */
export function aliasedActiveNonZeroDealSortTierSql(alias: string, valueSql: SQL): SQL {
  return sql`CASE WHEN ${aliasedReportableDealFilterSql(alias)} AND ${valueSql} > 0 THEN 0 ELSE 1 END`;
}

/**
 * CANONICAL Won-period date — the single source of truth for "when was this deal
 * Won", used by every Won read-site (getWonCloseSummary dashboard card,
 * getDealsForPipeline Won column, /deals?filter=won drill-down) and the shared
 * FilterBar date-scope. This is the protected 191 / $9,778,045.90 basis.
 *
 * FLIPPED (expand/migrate/contract step D): reads the app-owned
 * deals.won_closed_date column — populated by changeDealStage and backfilled from
 * HubSpot (migration 0141 + backfill-won-closed-date.ts). The legacy raw-HubSpot-JSON
 * parse (public.try_parse_hs_close_date over hubspot_extra_properties->>'hs_closed_won_date',
 * stripping the ''/'0' sentinels) is no longer read at query time and has no TS
 * helper; it survives only inline in the root scripts scripts/backfill-won-closed-date.ts
 * and scripts/verify-won-closed-date-parity.ts, which populate/audit won_closed_date.
 * Lives here in the leaf value module so the date-scope and the deals service share ONE
 * definition (no divergent reimplementation). `alias` is always a trusted
 * developer literal (e.g. "d"/"deals"), never user input.
 */
export function aliasedWonHsClosedWonDateSql(alias: string): SQL {
  return sql`${sql.raw(alias)}.won_closed_date`;
}
