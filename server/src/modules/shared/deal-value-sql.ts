import { sql, type SQL } from "drizzle-orm";
import {
  reportableDealSqlPredicate,
  closeTargetFarOutSqlPredicate,
  PROJECT_TYPE_CODE_BY_VALUE,
  PROJECT_TYPE_VALUES,
  SHOWCASE_ROUTE_BUCKETS,
  type ShowcaseRouteBucket,
} from "@trock-crm/shared/types";
import { TERMINAL_STAGE_SLUGS } from "./pipeline-terminal-stages.js";

type DealValueTable = {
  onHold: unknown;
  awardedAmount: unknown;
  bidBoardTotalSales?: unknown;
  bidEstimate: unknown;
  ddEstimate: unknown;
  forecastRevenue?: unknown;
  // A change-order child deal (0156) carries its value ONLY in awarded_amount, and a DEDUCTIVE CO carries
  // it NEGATIVE. REQUIRED, not optional: the sole production constructor is the real Drizzle `deals` table,
  // which always carries this column, so requiring it here means a hand-built table missing the field fails
  // to COMPILE in `server/src` — instead of silently falling back to the pre-CO chain the way an optional
  // field would. `server/tests` is not typechecked (server/tsconfig.json includes only src/**/*), so a test
  // literal missing the field is backstopped instead by the assertions in deal-value-sql.test.ts.
  isChangeOrder: unknown;
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

// A change-order child deal's value is awarded_amount VERBATIM — never the `> 0` fallback chain. A CO child
// has no other value column to fall back to (verified in prod: all 30 carry awarded_amount and nothing
// else), and a DEDUCTIVE CO is negative, which every `> 0` candidate drops — silently reporting the
// deduction as $0 on every Won surface. Provably inert for a POSITIVE CO, which is what the reconciliation
// test in deal-value-change-order.runtime.test.ts pins.
function changeOrderBranchSql(isChangeOrderSql: unknown, awardedSql: unknown, chainSql: SQL): SQL {
  return sql`CASE WHEN COALESCE(${isChangeOrderSql}, false) THEN COALESCE(${awardedSql}, 0) ELSE ${chainSql} END`;
}

// Derives BOTH the is_change_order predicate and the awarded_amount fallback from the SAME table object, so
// the two can never be hand-paired wrong at a call site (previously every call site built
// `COALESCE(<src>.is_change_order, false)` and `<src>.awarded_amount` separately and passed them as two
// same-typed SQL args that would swap with no compile error). Callers pass only the already-built chain.
function withChangeOrderBranch(table: DealValueTable, chainSql: SQL): SQL {
  return changeOrderBranchSql(table.isChangeOrder, table.awardedAmount, chainSql);
}

// Aliased twin of withChangeOrderBranch — derives both operands from the SAME alias string.
function withAliasedChangeOrderBranch(alias: string, chainSql: SQL): SQL {
  return changeOrderBranchSql(sql.raw(`${alias}.is_change_order`), sql.raw(`${alias}.awarded_amount`), chainSql);
}

function dealValueChainSql(table: DealValueTable, columns: readonly DealValueColumn[]): SQL {
  const chain = sql`COALESCE(${sql.join(
    columns.map((column) => positiveDealValueCandidateSql(tableColumnSql(table, column))),
    sql`, `
  )}, 0)`;
  return withChangeOrderBranch(table, chain);
}

// REQUIRED COLUMN at `alias` (in addition to whichever `columns` are passed in): is_change_order. Every
// aliased builder that resolves through this chain inherits the requirement — a narrowed CTE that projects
// an explicit column list (e.g. sales-tier1-service.ts's `open_deals`, which selects only id, name, stage_id,
// on_hold, value) will fail at RUNTIME, not compile time, if pointed at one of them; pass `deals`/`d`/`SELECT
// d.*`.
function aliasedDealValueChainSql(alias: string, columns: readonly DealValueColumn[]): SQL {
  const chain = sql.raw(
    `COALESCE(${columns
      .map((column) => aliasedPositiveDealValueCandidateSql(alias, column))
      .join(", ")}, 0)`
  );
  return withAliasedChangeOrderBranch(alias, chain);
}

// SCOPE — the ledger of hand-copied/hand-rolled twins of this chain that the deductive-change-order branch
// identified and retired. Every twin previously listed here is now CO-aware and struck: shared/src/types/
// deal-hold.ts (getRawDealValue / getRawAwardedDealValue, Task 2), client/src/lib/deal-utils.ts
// (resolveBestEstimate, Task 3), and — Task 4 — server/src/modules/daily-summary/service.ts,
// server/src/modules/admin/routes.ts (both cross-office aggregates), server/src/modules/search/service.ts,
// worker/src/jobs/deal-value-sql.ts, worker/src/jobs/rep-performance-rollup.ts, worker/src/jobs/index.ts
// and worker/src/jobs/won-metric-reduction-alert.ts.
//
// That last TypeScript twin — mobile-crm/src/components/DealCard.tsx's resolveDealValue — is now CO-aware
// as well: it takes a change-order child's awardedAmount VERBATIM, placed BELOW its hold check so a held
// deal is still worth 0 (matching storedOnHoldDealValueSql, which wraps this chain rather than being
// wrapped by it). It stays a hand-copied twin rather than a call into getRawDealValue because mobile-crm
// is a standalone Expo app, deliberately NOT an npm workspace member, so Metro cannot resolve shared/.
// Two `> 0` DISPLAY gates that discarded the corrected negative went with it: DealCard.tsx's
// displayAmount (now `!== 0`, so a non-zero value renders and only zero shows the em dash) and
// client/src/components/pipeline/pipeline-record-card.tsx's formatValue (same change; its value already
// resolved through the CO-aware shared getEffectiveDealValue, so only the gate was wrong — and the null
// it returned did not merely blank the amount, it let the card print the workflow route in the money's
// place). The other mobile-crm value surfaces carry no gate of their own — BoardCard.tsx and
// app/(app)/deals/[id].tsx both call displayAmount — so fixing those two functions reaches every render
// site in the table below.
//
// CHECKED, because a branch on a field the payload never sends would be inert. The surface that matters is
// not "every deals endpoint" but every screen that reaches this chain, and that set is enumerable rather
// than asserted: grep mobile-crm for `<DealCard`, `<BoardCard` and `displayAmount` outside the two
// component files themselves. That yields four render sites, each fed by one endpoint, and is_change_order
// reaches all four as `isChangeOrder`:
//   (tabs)/deals/index.tsx    <- GET /api/deals              (deals/routes.ts:866)  `...getTableColumns(deals)`
//   deals/board.tsx           <- GET /api/deals/pipeline     (routes.ts:1001)       `...getTableColumns(deals)`
//   deals/stage/[stageId].tsx <- GET /api/deals/stages/:id   (routes.ts:1064)       hand-written SELECT that
//     projects d.is_change_order (service.ts:3995) and maps it in mapDealStageWorkspaceRow (service.ts:1730)
//   deals/[id].tsx            <- GET /api/deals/:id/detail   -> getDealById, `...getTableColumns(deals)`
// Redaction cannot drop it on any of them: redactDealResponse strips only hubspotDealId,
// stripPrivateDealFieldsForViewer only the six commission fields, and the stage-page route redacts nothing
// (its SELECT never includes hubspot_deal_id). mobile-crm/src/api/types.ts already declared the field. All
// four rows also end in attachAtRiskResult, so the server-computed `effectiveValue` these cards PREFER is
// CO-aware too — the local chain above is the mixed-version fallback. Two further endpoints DO return deal
// rows to this app and are deliberately absent: POST /deals/:id/stage's `{ deal }` and the associations
// from /contacts/:id/deals. Neither is passed to displayAmount, so neither touches this chain.
//
// The first draft of this paragraph said "all three endpoints mobile-crm reads" and missed the stage page.
// Nothing was broken by the omission — that route was already CO-aware — but the count was an
// exhaustiveness claim nobody had checked, which is the fourth time this ledger has done that. Hence
// anchoring to render sites and naming the grep: the claim above is one a reader can re-run in one command
// rather than one they have to take on faith.
//
// That is the whole of what is claimed above: those edits, and that render-site trace. It is NOT a fresh
// completeness sweep of the repo — it rests on Task 4's sweep, whose edges are stated next. The plpgsql
// chain in migration 0184 remains outstanding separately, described at the end of this comment.
//
// ONE LEVEL UP from those per-deal display gates sat two AGGREGATE gates. Each broke the card/drill/
// aggregate rule rather than a single number, and both are now fixed:
//
//   • the mobile-crm board's COLUMN TOTAL. `<= 0` drew "—" for a column whose net went negative, while
//     the web header for the same stage (client/src/components/pipeline/pipeline-board-column.tsx:73)
//     formats `column.totalValue ?? 0` ungated and shows "-$30,000" — one office, two answers, depending
//     on which screen the rep is holding. Reachable through a CO child: it is Won, active and never
//     on-hold, so it is inside the Won column's SUM, and the `watched` scope is deal_subscriptions in
//     ISOLATION — watch the child without its parent and that column IS one deduction (the board asks
//     for won_all_time, so it is not a window that nets back out). Now formatColumnTotal in
//     mobile-crm/src/api/endpoints/pipeline.ts, moved off the screen so it is testable without a
//     renderer (the same split go-back.ts makes), rendering every column that summed anything. Zero is
//     treated differently here than on a CARD, deliberately: a column carries `activeCount`, computed
//     under the SAME on_hold FILTER as its SUM (deals/service.ts:3682-3684), so "nothing entered the
//     sum" and "the deals that did, summing to zero" are distinguishable — the ambiguity displayAmount
//     is stuck with simply does not exist one level up.
//
//   • client/src/pages/properties/property-list-page.tsx's hasLinkedPipeline, the membership test behind
//     the "Linked pipeline" card's drill. `> 0` dropped a property whose linked value nets negative out
//     of the drilled list while its money stayed inside the card's total, so the list could not be made
//     to add up and the site responsible for the gap was not on screen to be found — a vanished row is
//     worse than a wrong number. propertyLinkedDealValueSql SUMs signed, CO-aware values over a
//     property's active deals and a CO child inherits its parent's property_id, so a property nets
//     negative whenever its deductions outweigh what else still counts there (a soft-deleted parent is
//     out of that SUM entirely — it filters is_active — and a held one contributes 0, while the child
//     inherits neither flag). Now `!== 0`: "contributes to the number", which is the invariant the card
//     and its drill actually share. $0 properties stay excluded — they move the sum by nothing.
//
// What Task 4 actually swept, so the next reader knows the edges of this claim: `awarded_amount > 0` and
// the equivalent TS candidate-chain shapes across server/src, worker/src, client/src, shared/src (tests
// excluded), plus scripts/ and migrations/. That sweep also turned up two twins OUTSIDE the app source —
// scripts/verify-won-closed-date-parity.ts and scripts/lib/bid-board-won-date-reconcile.ts, both of which
// claimed in comments to mirror aliasedEffectiveWonDealValueSql — and both were fixed with the eight.
// It did NOT sweep client-field/, mobile/ or any non-TS/SQL surface, and it makes no claim about them.
//
// STILL OUTSTANDING and NOT fixed here (its own follow-up PR): the plpgsql Won-value chain inside
// migrations/0184_won_metric_reduction_alerts.sql (won_metric_reduction_impacts, old_value/new_value) is a
// `> 0`-gated twin, and the canonical impacts call passes p_exclude_change_orders = false, so change
// orders ARE in scope for it. The effect is worse than a wrong number: for a pure deductive-amount edit
// (say -10,000 -> -25,000) both old_value and new_value compute to 0 and both counts stay 1, so v_impacts
// is '{}' and the trigger returns without creating an event AT ALL. Sign flips and deletions still move
// the computed value, so they do fire and DO reach the worker's snapshotBestValue fix above. Until 0184 is
// fixed, such an email can read "Amount: -$25,000.00" beside an impacts line computed as "$50,000 ->
// $0.00" — internally inconsistent, though still strictly better than the old "Amount: $0.00". Fixing it
// needs a NEW migration rather than an edit here.

export function dealBestEstimateSql(table: DealValueTable): SQL {
  return dealValueChainSql(table, DEAL_VALUE_PRIORITY_CHAIN);
}

// 'estimating' stage only: DD outranks bid (awarded > dd > bid_board > bid). See ESTIMATING_VALUE_CHAIN.
export function dealEstimatingValueSql(table: DealValueTable): SQL {
  return dealValueChainSql(table, ESTIMATING_VALUE_CHAIN);
}

export function dealAwardedAmountSql(table: DealValueTable): SQL {
  const positiveOnly = sql`COALESCE(${positiveDealValueCandidateSql(table.awardedAmount)}, 0)`;
  return withChangeOrderBranch(table, positiveOnly);
}

export function dealAwardedFirstWithFallbackSql(table: DealValueTable): SQL {
  return dealValueChainSql(table, DEAL_VALUE_PRIORITY_CHAIN);
}

export function dealBestEstimateWithForecastSql(table: DealValueTable): SQL {
  return dealValueChainSql(table, FORECAST_FIRST_VALUE_CHAIN);
}

// OPEN-pipeline value-zeroing keys on EFFECTIVE hold = stored on_hold OR a hold horizon date past the
// 90-day mark, so a far-out OPEN deal contributes $0 to pipeline/forecast just like a parked one. Same
// boundary as the On Hold filter (shared CLOSE_TARGET_HOLD_HORIZON_DAYS + the America/Chicago anchor) so
// the two can't disagree. The horizon date is expected_close_date in every stage EXCEPT the genuine
// 'estimating' stage, where it is bid_due_date (2026-07-27) — the shared predicate branches on stage_id
// internally, so every caller here inherits it and none of them need new plumbing. (The reportable/count predicate is intentionally unchanged — a far-out deal is
// $0 but still counted.) The far-future auto-park leg lives ONLY in the ALIASED form
// (aliasedEffectiveDealValueSql), which runs against OPEN-filtered report populations. The COLUMN form is
// stored-on_hold ONLY: its sole consumer is the property linked-value SUM, which runs over MIXED (open +
// won) linked deals with no terminal filter, so applying the horizon here would wrongly zero realized
// won revenue. (A drizzle table can't be cheaply stage-filtered; the aliased report queries already
// exclude CRM-terminal deals, and the aliased form additionally exempts a Bid Board-MIRRORED terminal deal,
// so they carry the auto-park leg safely.)
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

/**
 * The same awarded-first chain as plain SQL TEXT, for callers that build query strings rather than drizzle
 * fragments — the tenant-sweeping internal routes run raw `pool.query` across every office schema.
 *
 * Exported as a rendering of DEAL_VALUE_PRIORITY_CHAIN rather than a hand-written COALESCE, so a change to
 * the chain reaches string callers too. A restated copy is how the platform ends up quoting two different
 * numbers for the same deal.
 *
 * INCLUDING the change-order branch, which the first draft of this function omitted. Without it the
 * positive-only chain drops a DEDUCTIVE change order's negative awarded_amount and renders 0 — so this
 * would not have been the same value chain at all, merely a similar-looking one, and the two would have
 * disagreed on precisely the rows where being wrong is most visible. Same REQUIRED COLUMN as the drizzle
 * twin: `is_change_order` must exist at `alias`.
 */
export function aliasedDealBestEstimateSqlText(alias: string): string {
  return dealValueChainSqlText(alias, DEAL_VALUE_PRIORITY_CHAIN);
}

/**
 * The 'estimating' stage chain (DD outranks bid) as plain SQL TEXT — the string twin of
 * aliasedDealEstimatingValueSql, rendered from the same ESTIMATING_VALUE_CHAIN constant.
 *
 * Exists because a string caller reporting on estimating-stage deals otherwise has only the DEFAULT chain
 * available and silently quotes bid-over-DD for exactly the population whose board and list show
 * DD-over-bid. Same REQUIRED COLUMN as the drizzle twin: `is_change_order` must exist at `alias`.
 */
export function aliasedDealEstimatingValueSqlText(alias: string): string {
  return dealValueChainSqlText(alias, ESTIMATING_VALUE_CHAIN);
}

/** Shared renderer for the two *SqlText builders, so the change-order branch cannot drift between them. */
function dealValueChainSqlText(alias: string, chainColumns: readonly DealValueColumn[]): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) {
    throw new Error(`Invalid SQL alias: ${alias}`);
  }
  const chain = `COALESCE(${chainColumns
    .map((column) => aliasedPositiveDealValueCandidateSql(alias, column))
    .join(", ")}, 0)`;
  return `CASE WHEN COALESCE(${alias}.is_change_order, false) THEN COALESCE(${alias}.awarded_amount, 0) ELSE ${chain} END`;
}

// 'estimating' stage only: DD outranks bid (awarded > dd > bid_board > bid). See ESTIMATING_VALUE_CHAIN.
export function aliasedDealEstimatingValueSql(alias: string): SQL {
  return aliasedDealValueChainSql(alias, ESTIMATING_VALUE_CHAIN);
}

export function aliasedDealAwardedAmountSql(alias: string): SQL {
  return withAliasedChangeOrderBranch(
    alias,
    sql.raw(`COALESCE(${aliasedPositiveDealValueCandidateSql(alias, "awarded_amount")}, 0)`)
  );
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

// Aliased twin of effectiveDealValueSql (OPEN/best-estimate value). Zeroes on the SAME condition the
// deals "On Hold" pill matches — aliasedEffectiveOnHoldConditionSql — so the value and the pill are
// byte-identical and cannot drift. NOT for won-value (see aliasedEffectiveWonDealValueSql).
//
// It used to compose the bare shared effectiveOnHoldSqlPredicate, which omits the Bid Board MIRROR
// terminal guard the pill carries: a CRM-open deal whose bid_board_stage_slug is already won/lost had its
// REALIZED value auto-parked to $0 by a far-out horizon date on the dashboard + report surfaces, while the
// deals list/board (aliasedStageAwareEffectiveDealValueSql), the On Hold pill, the client TS resolver and
// the worker digest/rollup all preserved it (Codex P2). This was the last family without the guard.
// `terminalStageIds` is deliberately left empty: this helper's consumers are already CRM-open-filtered
// populations, so the only terminal exposure left is the mirror. Prod impact measured $0 / 0 rows (no deal
// in any tenant schema is Bid Board-terminal while its CRM stage is open), so this only closes the
// inconsistency — it does not move today's dollars.
//
// REQUIRED COLUMNS at `alias`: on_hold, bid_board_stage_slug, stage_id, bid_due_date, expected_close_date,
// plus is_change_order via the default rawValueSql (aliasedDealBestEstimateSql — see the REQUIRED COLUMN
// note on aliasedDealValueChainSql, which every aliased builder in this family resolves through).
export function aliasedEffectiveDealValueSql(
  alias: string,
  rawValueSql: SQL = aliasedDealBestEstimateSql(alias)
): SQL {
  return sql`CASE WHEN ${aliasedEffectiveOnHoldConditionSql(alias)} THEN 0 ELSE COALESCE(${rawValueSql}, 0) END`;
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
// — its hold horizon date (the close target, or bid_due_date while it sits in the genuine 'estimating'
// stage) is more than CLOSE_TARGET_HOLD_HORIZON_DAYS out. A won/lost deal is realized/preserved,
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
 *
 * SIGN — `<> 0`, not `> 0` (2026-07-29). This tier is a LIVENESS partition, not a value ranking: the
 * population it exists to demote is DEAD rows — parked (on_hold) deals and deals carrying no value at
 * all. It is deliberately the leading key so those stay out of the way under EVERY sort. A DEDUCTIVE
 * change order (a live Won child deal whose awarded_amount is negative — see withChangeOrderBranch) is
 * not in that population: it is a live deal with a real, non-zero value that the count and the total on
 * the same screen both include. So the correct test is "has a value at all", and the original `> 0` was
 * never a sign policy — it was shorthand for non-zero, correct only while every value in the system was
 * non-negative, which is exactly the assumption the deductive-CO branch removes.
 *
 * PROVABLY INERT outside that one population. For any row that is NOT a change order, this file's value
 * chains are `COALESCE(<candidates, each gated `> 0`>, 0)` wrapped in a hold-zeroing CASE, so they can
 * never evaluate below zero; `<> 0` and `> 0` therefore select IDENTICALLY on every non-CO row. The only
 * rows this operator can move are change-order children with a negative awarded_amount. (Pinned in
 * tests/modules/shared/deal-sort-tier-sign.runtime.test.ts, which computes both operators side by side.)
 *
 * WHY NOT a sort-aware tier. The reviewed alternative was to keep `> 0` while the surface sorts by value
 * and use `<> 0` otherwise, so a deduction could never top a money ranking. It was rejected on three
 * counts. (1) A negative is the SMALLEST number, so a descending value sort already places it at the
 * bottom of the live tier without any help — the intent is satisfied by the sort itself. (2) It is
 * actively wrong for an ASCENDING value sort, where a deduction genuinely belongs first and the tier
 * would force it last. (3) VISIBILITY: the board ships a tiny per-column preview (8 cards on web,
 * 15 on mobile-crm) and the deals list paginates, while the column header count and total include every
 * row — so filing a live deduction behind every on-hold and $0 row can push it off the visible page
 * entirely, leaving a total the visible cards cannot account for. That is a card/aggregate
 * reconciliation break, not an ordering preference. Keeping the tier a pure function of the row also
 * keeps it in lockstep with its client twin, compareDrilldownDeals in
 * client/src/pages/deals/deal-list-page.tsx, whose `tierOf` makes the same non-zero test. The two are a
 * twin pair; change them together.
 */
export function aliasedActiveNonZeroDealSortTierSql(alias: string, valueSql: SQL): SQL {
  return sql`CASE WHEN ${aliasedReportableDealFilterSql(alias)} AND ${valueSql} <> 0 THEN 0 ELSE 1 END`;
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

/**
 * The two buckets of the Service / Other split. "service" is deals.workflow_route = 'service'; "other" is
 * EVERYTHING else. Same meaning as the deals dashboard's Service / Non-service At Risk cards (#1035) —
 * one definition of "service" across the platform, so a director comparing the two surfaces is comparing
 * the same population.
 *
 * RE-EXPORTED, not redeclared: the vocabulary lives in shared/ so the client's URL codec and this SQL layer
 * cannot drift to different bucket names. The alias keeps this module's existing SQL-side naming.
 */
export const WORKFLOW_ROUTE_BUCKETS = SHOWCASE_ROUTE_BUCKETS;
export type WorkflowRouteBucket = ShowcaseRouteBucket;

/**
 * JS `String.prototype.trim()` expressed as an explicit character set for Postgres `btrim`.
 *
 * NOT `btrim(x)` and NOT `[[:space:]]`. The one-argument btrim strips ASCII SPACE ONLY, so a tab-wrapped
 * value survives it; the POSIX class is evaluated per the server's collation, so it is
 * correct-under-the-locale-we-tested rather than correct, and no behavioural test can catch that (both
 * sides of a parity test run on the same backend and agree in CI while diverging in production).
 * Migration 0216 learned both of these the expensive way — see its suite. Pinned character-for-character
 * against JS \s by a test, so a well-meaning simplification fails there rather than in a report.
 *
 * Built from CODE POINTS, never a written-out string literal. btrim's second argument is a SET of
 * characters, not a range, so the tempting "\t-\r" spelling does not mean "tab through carriage
 * return" — it means {tab, HYPHEN, carriage return}, and would quietly strip hyphens off real values.
 */
const JS_TRIM_CHARS = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, // tab, LF, VT, FF, CR
  0x20, 0xa0, 0x1680, // space, NBSP, ogham space mark
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, // quad block
  0x2028, 0x2029, // line separator, paragraph separator
  0x202f, 0x205f, 0x3000, // narrow NBSP, medium mathematical space, ideographic space
  0xfeff, // zero-width NBSP / BOM
].map((code) => String.fromCodePoint(code)).join("");

/** `normalizeProjectType` (shared/types) in SQL: JS-trim, then lower-case. */
function normalizedProjectTypeSql(alias: string): SQL {
  return sql`lower(btrim(COALESCE(${sql.raw(alias)}.project_type, ''), ${JS_TRIM_CHARS}))`;
}

/**
 * THE CANONICAL "IS THIS SERVICE?" TEST, and the reason the Monday Showcase was reporting ~$490k of
 * service against a single service rep's $1.1M.
 *
 * `resolveProjectTypeCode` (server/src/services/projectNumber.ts) is the platform's definition of a
 * deal's project type, and it is emphatic about precedence: **project_type WINS, and workflow_route is
 * only consulted when nothing else answers.** The `4` in a deal number like `DFW-4-04126-AE` is DERIVED
 * from project_type at creation, which is why deals whose number says service were sitting in the
 * "Normal" bucket: every reader here tested `workflow_route` ALONE, the one input the canonical function
 * consults LAST, and nothing on the write side ever derives it from the type. So a correctly-typed
 * service deal reads as "confidently not service" — `workflow_route` is NOT NULL DEFAULT 'normal', so an
 * unset route is indistinguishable from a deliberate one.
 *
 * The three tiers below mirror resolveProjectTypeCode exactly, in its order:
 *   1. a VALID `deals.project_type` -> its code (nothing else consulted);
 *   2. else the configured digit on `project_type_config.code` via `deals.project_type_id` — the SQL
 *      analogue of the function's `projectTypes` digit tier, and what actually stamps the deal number;
 *   3. else, and only else, `workflow_route`.
 * COALESCE over three nullable booleans expresses that fall-through directly: a tier that cannot answer
 * yields NULL and the next one is consulted.
 *
 * The value list and the '4' are generated FROM `PROJECT_TYPE_VALUES` / `PROJECT_TYPE_CODE_BY_VALUE`, not
 * retyped, because SQL cannot import the constant and a hand-copied list is how this drifts back apart.
 *
 * KEEPING THIS AS A SAFETY NET IS THE POINT. Deriving workflow_route on write (and backfilling it) makes
 * the column correct TODAY; reading the canonical definition here is what stops ONE missed write path
 * from silently recreating the undercount. Do not "simplify" this back to the raw column on the grounds
 * that the data is now clean.
 *
 * `alias` is always a trusted developer literal ("d"/"deals"), never user input.
 */
export function aliasedIsServiceProjectSql(alias: string): SQL {
  const normalized = normalizedProjectTypeSql(alias);
  const knownValues = sql.join(
    PROJECT_TYPE_VALUES.map((value) => sql`${value}`),
    sql`, `
  );
  const serviceCode = PROJECT_TYPE_CODE_BY_VALUE.service;

  return sql`COALESCE(
    CASE WHEN ${normalized} IN (${knownValues}) THEN ${normalized} = 'service' END,
    (
      SELECT CASE WHEN btrim(COALESCE(ptc.code, ''), ${JS_TRIM_CHARS}) ~ '^[1-9]$'
                  THEN btrim(ptc.code, ${JS_TRIM_CHARS}) = ${serviceCode} END
        FROM public.project_type_config ptc
       WHERE ptc.id = ${sql.raw(alias)}.project_type_id
    ),
    ${sql.raw(alias)}.workflow_route = 'service',
    false
  )`;
}

/**
 * Service-vs-Other narrowing, as a LEADING-` AND ` fragment (the same composition idiom as the
 * showcase's repScopeSql / regionScopeSql) or EMPTY when nothing should be narrowed.
 *
 * NOW ASKS `aliasedIsServiceProjectSql`, NOT the raw `workflow_route` column. That change is the fix for
 * the Monday Showcase under-reporting service: this fragment is the single definition behind BOTH the
 * showcase's Service / Other chips and the deals dashboard's Service / Non-service At Risk cards (#1035),
 * so both surfaces were narrowing on the one field the canonical definition consults LAST. Deals whose
 * number literally reads `DFW-4-…` were counted as normal work.
 *
 * "other" remains the exact complement — `NOT (is service)` — rather than a re-derived rule, which is
 * what keeps the partition total. The old spelling needed an explicit `IS NULL OR <> 'service'` because a
 * bare inequality is UNKNOWN for a NULL row and would drop it from BOTH buckets; the canonical predicate
 * COALESCEs to `false` instead, so it is never NULL and a plain NOT is total by construction.
 *
 * TOTALITY IS THE POINT: service ∪ other = every row and service ∩ other = ∅, so a bucket's figure plus its
 * complement's always re-sums to the unfiltered figure. Callers depend on that additivity to prove a split
 * lost nothing.
 *
 * `undefined` (caller passed no selection) and BOTH buckets selected return the SAME empty fragment — no
 * predicate at all. So a surface that ships this filter defaulted to "everything" emits SQL byte-identical
 * to the surface before the filter existed, and cannot move a number on first load. That property is why
 * this fix moves the SPLIT without moving any unfiltered total.
 *
 * `alias` is always a trusted developer literal ("d"/"deals"), never user input.
 */
export function aliasedWorkflowRouteFilterSql(
  alias: string,
  buckets?: readonly WorkflowRouteBucket[]
): SQL {
  if (buckets === undefined) return sql``;
  const service = buckets.includes("service");
  const other = buckets.includes("other");
  if (service && other) return sql``;
  if (service) return sql` AND ${aliasedIsServiceProjectSql(alias)}`;
  if (other) {
    return sql` AND NOT ${aliasedIsServiceProjectSql(alias)}`;
  }
  // Neither bucket. There is no honest row set for "no selection at all", and emitting a `false` predicate
  // would return zeros that read like real measurements — the exact failure this split exists to avoid. The
  // request layer rejects an empty selection with a 400 long before this; the throw is the invariant backstop.
  throw new Error("workflow-route filter needs at least one bucket: service and/or other");
}
