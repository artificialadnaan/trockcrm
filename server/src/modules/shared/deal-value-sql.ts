import { sql, type SQL } from "drizzle-orm";
import { reportableDealSqlPredicate } from "@trock-crm/shared/types";

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

export function effectiveDealValueSql(table: DealValueTable, rawValueSql: SQL = dealBestEstimateSql(table)): SQL {
  return sql`CASE WHEN COALESCE(${table.onHold}, false) THEN 0 ELSE COALESCE(${rawValueSql}, 0) END`;
}

export function effectiveAwardedDealValueSql(
  table: DealValueTable,
  rawValueSql: SQL = dealAwardedAmountSql(table)
): SQL {
  return effectiveDealValueSql(table, rawValueSql);
}

export function effectiveWonDealValueSql(table: DealValueTable): SQL {
  return effectiveDealValueSql(table, dealAwardedFirstWithFallbackSql(table));
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

export function aliasedEffectiveDealValueSql(
  alias: string,
  rawValueSql: SQL = aliasedDealBestEstimateSql(alias)
): SQL {
  return sql`CASE WHEN COALESCE(${sql.raw(`${alias}.on_hold`)}, false) THEN 0 ELSE COALESCE(${rawValueSql}, 0) END`;
}

export function aliasedEffectiveAwardedDealValueSql(
  alias: string,
  rawValueSql: SQL = aliasedDealAwardedAmountSql(alias)
): SQL {
  return aliasedEffectiveDealValueSql(alias, rawValueSql);
}

export function aliasedEffectiveWonDealValueSql(alias: string): SQL {
  return aliasedEffectiveDealValueSql(alias, aliasedDealAwardedFirstWithFallbackSql(alias));
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
