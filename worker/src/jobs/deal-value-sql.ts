import {
  closeTargetFarOutSqlPredicate,
  LOST_DEAL_STAGE_SLUGS,
  WON_DEAL_STAGE_SLUGS,
} from "@trock-crm/shared/types";

/**
 * The worker's raw-STRING twin of the server's open-pipeline value expression.
 *
 * weekly-digest and rep-performance-rollup run outside Drizzle (node-postgres text queries), so they
 * cannot compose the server's `aliasedEffectiveDealValueSql`; they can only inherit the shared hold rule
 * through `closeTargetFarOutSqlPredicate`. Both jobs used to hand-build the identical CASE inline, which
 * meant the rule lived in three places (server SQL, this string, and a hand-copied paste in the
 * cross-surface reconciliation test) with nothing forcing them to move together. This leaf module is that
 * one place: it imports NO worker db/pool, so tests — including the server-side cross-surface
 * reconciliation suite — can import and execute the real production expression instead of retyping it.
 *
 * NOTE the value CHAIN here is deliberately bid-board-first (bid_board_total_sales > bid_estimate >
 * dd_estimate > awarded_amount), which is NOT the server's awarded-first DEAL_VALUE_PRIORITY_CHAIN. That
 * divergence predates this module and is preserved verbatim — unifying the two chains would move the
 * digest/rollup dollars and belongs in its own change.
 */

const TERMINAL_BID_BOARD_SLUG_LIST = [...WON_DEAL_STAGE_SLUGS, ...LOST_DEAL_STAGE_SLUGS]
  .map((slug) => `'${slug.replace(/'/g, "''")}'`)
  .join(", ");

/**
 * A Bid Board-owned deal can be terminal (won/lost) in `bid_board_stage_slug` while its CRM `stage_id`
 * still joins to a non-terminal stage — its realized value must be PRESERVED, never auto-parked by a
 * far-out horizon date (mirrors the server terminal exemption).
 */
export function workerBidBoardTerminalSql(alias = "d"): string {
  return `COALESCE(${alias}.bid_board_stage_slug, '') IN (${TERMINAL_BID_BOARD_SLUG_LIST})`;
}

/**
 * A change-order child deal (0156) carries its value ONLY in awarded_amount, and a DEDUCTIVE CO carries it
 * NEGATIVE — so it is taken VERBATIM, ahead of the `> 0` chain, which would drop the negative and report
 * the deduction as $0. The raw-string twin of the server's withChangeOrderBranch
 * (server/src/modules/shared/deal-value-sql.ts); the two MUST NOT drift. Inert for a positive CO (its
 * awarded_amount was already the only candidate that could match). REQUIRED COLUMN at `alias`:
 * is_change_order, in addition to the four value columns.
 *
 * EXPORTED so the worker's other hand-built chain (rep-performance-rollup's awarded-first closed-value
 * expression) wraps itself with THIS branch rather than a second hand-copy of it — the CO rule stays in
 * one place even though the two chains deliberately order their candidates differently.
 */
export function withWorkerChangeOrderBranch(alias: string, chainSql: string): string {
  return `CASE WHEN COALESCE(${alias}.is_change_order, false) THEN COALESCE(${alias}.awarded_amount, 0) ELSE ${chainSql} END`;
}

/** RAW (never zeroed) current deal value — the digest/rollup value chain. */
export function workerCurrentDealValueSql(alias = "d"): string {
  return withWorkerChangeOrderBranch(
    alias,
    `COALESCE(
  CASE WHEN ${alias}.bid_board_total_sales > 0 THEN ${alias}.bid_board_total_sales END,
  CASE WHEN ${alias}.bid_estimate > 0 THEN ${alias}.bid_estimate END,
  CASE WHEN ${alias}.dd_estimate > 0 THEN ${alias}.dd_estimate END,
  CASE WHEN ${alias}.awarded_amount > 0 THEN ${alias}.awarded_amount END,
  0
)`
  );
}

/**
 * "Total active pipeline value": sums a CRM-non-terminal population, so it must zero a far-out
 * (CLOSE_TARGET_HOLD_HORIZON_DAYS+) auto-held deal to $0 — matching the deals list/kanban totals — EXCEPT a
 * Bid Board-mirrored terminal deal, whose realized value is preserved. The horizon date itself is the close
 * target everywhere but the genuine estimating stage, where the shared predicate measures from the BID due
 * date (2026-07-27); this expression inherits that with no plumbing of its own. The stored `on_hold` case is
 * already excluded by REPORTABLE_DEAL_SQL in each caller's WHERE, so only the far-out leg is added here.
 */
export function workerEffectiveCurrentDealValueSql(alias = "d"): string {
  return `CASE WHEN NOT (${workerBidBoardTerminalSql(alias)}) AND (${closeTargetFarOutSqlPredicate(
    alias
  )}) THEN 0 ELSE ${workerCurrentDealValueSql(alias)} END`;
}
