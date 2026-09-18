/**
 * THE DEAL-VALUE PRIORITY CHAINS, and their plain-SQL-TEXT renderings.
 *
 * The chain ORDER lives here — not in `server/src/modules/shared/deal-value-sql.ts`, which owns the drizzle
 * builders and used to own the order too. It moved for the same reason the terminal-stage union and the Bid
 * Board mirror predicate did: nothing under `worker/src` can import `server/src` (worker's tsconfig pins
 * `rootDir: ./src`), so a worker cron reporting on deal value had only two options, and both were wrong.
 * Hand-roll the COALESCE and quote a number no CRM surface agrees with, or reach for the worker's own
 * generic chain and quote a number the page in the CTA disagrees with. That second one actually happened:
 * the bid-due-date report emailed a Bid-Board-first figure while its own click-through rendered a DD-first
 * one, for any deal carrying both.
 *
 * The server re-exports these under its existing names, so there is exactly one definition of what a deal
 * is worth and in what order the candidates are tried.
 */

export type DealValueColumn =
  | "forecast_revenue"
  | "bid_board_total_sales"
  | "bid_estimate"
  | "dd_estimate"
  | "awarded_amount";

/**
 * DEFAULT deal-value priority chain (awarded-first). Used by every stage EXCEPT the single 'estimating'
 * stage, which overrides DD ABOVE bid — see ESTIMATING_VALUE_CHAIN. Each candidate is gated `> 0`, so BOTH
 * 0 and NULL fall through; the chain's final fallback is 0.
 */
export const DEAL_VALUE_PRIORITY_CHAIN = [
  "awarded_amount",
  "bid_board_total_sales",
  "bid_estimate",
  "dd_estimate",
] as const satisfies readonly DealValueColumn[];

/**
 * STAGE-AWARE override for the single 'estimating' stage (2026-06-18, Adnaan): during estimating the bid is
 * in-progress/incomplete, so DD outranks bid — awarded > dd_estimate > bid_board_total_sales > bid_estimate.
 * Awarded still wins; bid is NOT skipped, just outranked when DD exists (a bid-only estimating deal keeps
 * its bid, never $0).
 *
 * SCOPE, because this is the chain a new caller most often reaches for wrongly: it applies to the DEALS
 * pipeline paths — the kanban/stage-workspace per-column totals and the deals-list filter/sort/total plus
 * the STAGE DRILL — mirrored by the TS card resolvers. Dashboard and report value aggregates deliberately
 * keep the default open chain, so an estimating deal can read DD-first on the deals board and bid-first in a
 * report. Pick by the surface your number has to reconcile with: an email whose CTA lands on the stage drill
 * belongs on THIS chain, because that is the page the reader compares it against one click later.
 */
export const ESTIMATING_VALUE_CHAIN = [
  "awarded_amount",
  "dd_estimate",
  "bid_board_total_sales",
  "bid_estimate",
] as const satisfies readonly DealValueColumn[];

export const FORECAST_FIRST_VALUE_CHAIN = [
  "forecast_revenue",
  ...DEAL_VALUE_PRIORITY_CHAIN,
] as const satisfies readonly DealValueColumn[];

const SQL_ALIAS = /^[a-z_][a-z0-9_]*$/i;

export function aliasedPositiveDealValueCandidateSqlText(alias: string, column: string): string {
  return `CASE WHEN ${alias}.${column} > 0 THEN ${alias}.${column} END`;
}

/**
 * Shared renderer for the *SqlText builders, so the change-order branch cannot drift between them.
 *
 * INCLUDING that branch, which the first draft of the server's version omitted. Without it the positive-only
 * chain drops a DEDUCTIVE change order's negative awarded_amount and renders 0 — so it would not be the same
 * value chain at all, merely a similar-looking one, and the two would disagree on precisely the rows where
 * being wrong is most visible.
 *
 * REQUIRED COLUMNS at `alias`: `is_change_order`, plus whichever chain columns are passed.
 */
export function dealValueChainSqlText(
  alias: string,
  chainColumns: readonly DealValueColumn[]
): string {
  if (!SQL_ALIAS.test(alias)) {
    throw new Error(`Invalid SQL alias: ${alias}`);
  }
  const chain = `COALESCE(${chainColumns
    .map((column) => aliasedPositiveDealValueCandidateSqlText(alias, column))
    .join(", ")}, 0)`;
  return `CASE WHEN COALESCE(${alias}.is_change_order, false) THEN COALESCE(${alias}.awarded_amount, 0) ELSE ${chain} END`;
}

/** The awarded-first chain as plain SQL text, for callers that build query strings rather than fragments. */
export function aliasedDealBestEstimateSqlText(alias: string): string {
  return dealValueChainSqlText(alias, DEAL_VALUE_PRIORITY_CHAIN);
}

/** The 'estimating' stage chain (DD outranks bid) as plain SQL text. */
export function aliasedDealEstimatingValueSqlText(alias: string): string {
  return dealValueChainSqlText(alias, ESTIMATING_VALUE_CHAIN);
}
