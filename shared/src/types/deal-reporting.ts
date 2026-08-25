import { CLOSE_TARGET_HOLD_HORIZON_DAYS } from "./deal-hold-risk.js";
import {
  CANONICAL_TERMINAL_DEAL_STAGE_SLUGS,
  GENUINE_ESTIMATING_DEAL_STAGE_SLUGS,
  LOST_DEAL_STAGE_SLUGS,
  WON_DEAL_STAGE_SLUGS,
} from "./workflow.js";

type DealReportabilityLike = {
  onHold?: boolean | null;
};

const SQL_IDENTIFIER_PATH = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/;

// The America/Chicago "today" anchor — the SAME boundary the forecast SQL and the at-risk close-target
// rule use, so the On Hold filter and the forecast never disagree by a day.
const CT_TODAY_SQL = "(now() AT TIME ZONE 'America/Chicago')::date";

// Compile-time constants from the workflow module, never user input — but quote-escaped anyway so this
// stays injection-proof if the slug list is ever sourced from data.
function sqlSlugList(slugs: readonly string[]): string {
  return slugs.map((slug) => `'${slug.replace(/'/g, "''")}'`).join(", ");
}

const GENUINE_ESTIMATING_STAGE_SLUG_SQL_LIST = sqlSlugList(GENUINE_ESTIMATING_DEAL_STAGE_SLUGS);

/**
 * Every stage slug that means a deal is REALIZED — won or lost, canonical or legacy alias.
 *
 * The same derivation `server/src/modules/shared/pipeline-terminal-stages.ts` used to make privately,
 * moved here so the ONE list is reachable from `worker/` too. It is re-exported from there rather than
 * restated, because a second copy of this union is how a stage rename ends up terminal on one surface and
 * open on another — and the surfaces that disagree would be a report's population and the dollars it
 * quotes.
 */
export const TERMINAL_DEAL_STAGE_SLUGS = [
  ...new Set([
    ...CANONICAL_TERMINAL_DEAL_STAGE_SLUGS,
    ...WON_DEAL_STAGE_SLUGS,
    ...LOST_DEAL_STAGE_SLUGS,
  ]),
] as readonly string[];

const TERMINAL_STAGE_SLUG_SQL_LIST = sqlSlugList(TERMINAL_DEAL_STAGE_SLUGS);

export function isDealActivelyOnHold(deal: DealReportabilityLike): boolean {
  return deal.onHold === true;
}

export function isReportableDeal(deal: DealReportabilityLike): boolean {
  return !isDealActivelyOnHold(deal);
}

export function reportableDealSqlPredicate(identifierPath?: string): string {
  if (!identifierPath) {
    return "COALESCE(on_hold, false) = false";
  }

  if (!SQL_IDENTIFIER_PATH.test(identifierPath)) {
    throw new Error(`Invalid reportable deal SQL identifier: ${identifierPath}`);
  }

  return `COALESCE(${identifierPath}.on_hold, false) = false`;
}

/**
 * "Effectively on hold" = the stored `on_hold` flag OR a hold horizon date far enough out (more than
 * CLOSE_TARGET_HOLD_HORIZON_DAYS CT-days) that the deal is treated as parked. The canonical two-leg
 * definition, and the shape the emitted-SQL tests pin; the horizon constant is shared with the at-risk
 * module so the SQL day boundary and the TS day-math can never drift. Pure string builder (no drizzle dep),
 * consumed via `sql.raw` like reportableDealSqlPredicate.
 *
 * NOTE this bare form carries NO terminal exemption, so it is only correct for a population that has no
 * terminal rows OR no `bid_board_stage_slug` column to test. Every server SQL consumer instead composes
 * `aliasedEffectiveOnHoldConditionSql`, which gates the far-out leg behind the CRM stage-id terminal set AND
 * the Bid Board mirror — a realized deal must never be auto-parked by a stale horizon date. Reach for that
 * one unless you know your population is open-only.
 */
export function effectiveOnHoldSqlPredicate(identifierPath?: string): string {
  if (identifierPath && !SQL_IDENTIFIER_PATH.test(identifierPath)) {
    throw new Error(`Invalid effective on-hold SQL identifier: ${identifierPath}`);
  }
  const onHold = identifierPath ? `${identifierPath}.on_hold` : "on_hold";
  return `(COALESCE(${onHold}, false) = true OR (${closeTargetFarOutSqlPredicate(identifierPath)}))`;
}

/**
 * The row is in the genuine normal-route 'estimating' stage. Classified by a subselect over
 * `public.pipeline_stage_config` rather than a caller-threaded stage-id list ON PURPOSE: `stage_id` is on
 * the deals row at EVERY consumer of this predicate (~50 queries across deals/dashboard/reports/companies/
 * properties/worker), while a caller-resolved id set is not — threading one would leave most surfaces on
 * the old rule, which is exactly the silent partial-application this codebase keeps re-introducing.
 * pipeline_stage_config is a small (38-row) table shared by every tenant schema and lives ONLY in `public`, so the
 * qualification is required (tenant queries run with the office schema first on the search_path) and
 * Postgres hoists the subselect to a one-shot InitPlan.
 */
export function genuineEstimatingStageSqlPredicate(identifierPath?: string): string {
  if (identifierPath && !SQL_IDENTIFIER_PATH.test(identifierPath)) {
    throw new Error(`Invalid genuine-estimating SQL identifier: ${identifierPath}`);
  }
  const stageId = identifierPath ? `${identifierPath}.stage_id` : "stage_id";
  return (
    `${stageId} IN (SELECT id FROM public.pipeline_stage_config ` +
    `WHERE slug IN (${GENUINE_ESTIMATING_STAGE_SLUG_SQL_LIST}))`
  );
}

/**
 * The DATE the far-out auto-park horizon is measured against.
 *
 * Everywhere EXCEPT the genuine 'estimating' stage that is the project's `expected_close_date`. In
 * estimating it is the BID due date, falling back to `expected_close_date` (Adnaan, 2026-07-27): work
 * sitting in estimating has to stay relevant and quick, and its bid deadline is almost always much nearer
 * than the project close target — so a deal whose bid is not due for another quarter is parked even though
 * its close date looks near-term.
 *
 * NULL bid due date falls back to `expected_close_date` rather than never auto-parking. `bid_due_date` is
 * NULL on 91% of deals (it is only a required field on the lead-conversion path), and "no bid due date ⇒
 * never park" would hand a single missing field the power to un-park stale forecasts: on prod it would
 * have RELEASED $4,389,810.67 of far-out estimating deals back into reported pipeline (two deals, one of
 * them a $4.0M close target 4+ months out) — the exact stale-forecast inflation auto-on-hold exists to
 * prevent. The fallback is also strictly conservative: for a null-bid row it reproduces today's behaviour
 * byte-for-byte, so the null case can never produce a surprise dollar swing. (Deliberately NOT
 * `LEAST(bid_due_date, expected_close_date)` either — that only ever ADDS holds and would make "whichever
 * date is later" permanently irrelevant, which is not the rule that was asked for.)
 *
 * `bid_due_date` is a timestamptz stored at UTC midnight (see migration 0132 and the lineage resolver's
 * dealBidDueDateToDateOnly), so it MUST be read `AT TIME ZONE 'UTC'` before `::date`. A bare `::date`
 * resolves in the SESSION timezone; prod happens to run Etc/UTC today, but a pooler or a `SET TIME ZONE`
 * would silently shift the calendar day by one and flip a deal's hold verdict — and therefore its dollar
 * value — on a surface nobody was looking at.
 *
 * REQUIRED COLUMNS at the caller's alias: `stage_id`, `bid_due_date`, `expected_close_date`. A future CTE
 * that projects an explicit narrow column list will fail at runtime here; pass `deals`/`d`/`SELECT d.*`.
 *
 * EXPORTED so an operator census can PRINT the horizon date a verdict was measured against (old vs new)
 * rather than hand-rolling the CASE/COALESCE a second time and quietly disagreeing with the app. The
 * predicate below remains the thing to reach for when you only need the verdict.
 */
export function holdHorizonDateSql(identifierPath?: string, bidDueDateSql?: string): string {
  // Validated HERE as well as in closeTargetFarOutSqlPredicate now that this is a public entry point —
  // the alias reaches raw SQL either way, so the guard has to sit on every door, not just the old one.
  if (identifierPath && !SQL_IDENTIFIER_PATH.test(identifierPath)) {
    throw new Error(`Invalid hold horizon SQL identifier: ${identifierPath}`);
  }
  const column = (name: string) => (identifierPath ? `${identifierPath}.${name}` : name);
  // The bid-due-date expression is overridable so a caller that has already resolved the EFFECTIVE date
  // (e.g. lead-first, per DEAL_FIELD_OWNERSHIP) measures the horizon against the same date it reports on.
  // Default unchanged: the deal column, UTC-normalized. Callers passing an override own its cast — a plain
  // DATE must NOT be re-read AT TIME ZONE 'UTC'.
  const bidDue = bidDueDateSql ?? `(${column("bid_due_date")} AT TIME ZONE 'UTC')::date`;
  return (
    `CASE WHEN ${genuineEstimatingStageSqlPredicate(identifierPath)} ` +
    `THEN COALESCE(${bidDue}, ${column("expected_close_date")}) ` +
    `ELSE ${column("expected_close_date")} END`
  );
}

/**
 * JUST the far-out auto-park leg of the effective-on-hold rule: the deal's hold horizon date (see
 * holdHorizonDateSql — `expected_close_date`, or the bid due date in the estimating stage) is more than
 * CLOSE_TARGET_HOLD_HORIZON_DAYS CT-days out. Extracted so a TERMINAL-AWARE caller (server) can gate this
 * leg behind a `NOT terminal` guard while reusing the EXACT day-math — the horizon constant and the
 * America/Chicago anchor — so the SQL and TS twin (isDealEffectivelyOnHold) can never drift. Pure string
 * builder; consumed via `sql.raw`. The stored `on_hold` flag is the OTHER, always-applies leg (see
 * effectiveOnHoldSqlPredicate).
 */
export function closeTargetFarOutSqlPredicate(
  identifierPath?: string,
  options: { asOfDate?: string | null; bidDueDateSql?: string } = {}
): string {
  if (identifierPath && !SQL_IDENTIFIER_PATH.test(identifierPath)) {
    throw new Error(`Invalid effective on-hold SQL identifier: ${identifierPath}`);
  }
  const today = ctTodaySql(options.asOfDate);
  // The horizon expression is emitted twice rather than aliased once — this is a pure string builder with
  // no CTE/LATERAL to hang a name on. The `IS NOT NULL` leg is NOT redundant with the comparison: callers
  // negate this predicate (`NOT (...)` in the deals "active" status filter), and under three-valued logic
  // `NOT (NULL > x)` is NULL (row dropped) while `NOT (NULL IS NOT NULL AND ...)` is TRUE (row kept). A
  // deal with no horizon date must read as ACTIVE, not vanish.
  const horizonDate = holdHorizonDateSql(identifierPath, options.bidDueDateSql);
  return (
    `(${horizonDate}) IS NOT NULL AND ` +
    `(${horizonDate}) > ${today} + INTERVAL '${CLOSE_TARGET_HOLD_HORIZON_DAYS} days'`
  );
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The CT "today" the far-out horizon is measured from — `now()` by default, or a caller-supplied DAY.
 *
 * The override exists for a report that must reproduce a PARTICULAR run rather than describe this instant.
 * The bid-due-date report's Thursday catch-up is exactly that: with the boundary on `now()`, a
 * null-bid-date estimating deal whose close target sits 91 days after the report's Wednesday is auto-parked
 * on Wednesday and not on Thursday, so the footer's reconciliation count changes between a run and the
 * catch-up that is supposed to reproduce it.
 *
 * A validated ISO day is interpolated rather than bound, because these builders emit standalone predicate
 * TEXT with no parameter list of their own; the format check is what keeps that safe.
 */
function ctTodaySql(asOfDate?: string | null): string {
  if (asOfDate == null) return CT_TODAY_SQL;
  if (!ISO_DATE.test(asOfDate)) {
    throw new Error(`Invalid as-of date (expected YYYY-MM-DD): ${asOfDate}`);
  }
  return `DATE '${asOfDate}'`;
}

// ---------------------------------------------------------------------------------------------------
// WORKER-REACHABLE STRING TWINS of the server's three "standard exclusion" builders.
//
// `aliasedActiveDealCountFilterSql`, `aliasedBidBoardTerminalSql` and `aliasedEffectiveOnHoldConditionSql`
// live in server/src/modules/shared/deal-value-sql.ts and return drizzle `SQL` objects. A worker cron
// issues raw `client.query("…")` strings and `worker/tsconfig.json` pins `rootDir: ./src`, so no worker
// source can import them at all — which left the only options "hand-roll the predicates" (three existing
// entries in this codebase's own violations ledger) or "report on a different population than the app
// does". These are the third option. They render from the SAME constants as the drizzle builders, so the
// two cannot drift on a stage rename.
//
// `bidBoardTerminalSqlPredicate` and `TERMINAL_DEAL_STAGE_SLUGS` are re-exported by the server modules
// that used to own them, rather than copied — see pipeline-terminal-stages.ts and deal-value-sql.ts.
// ---------------------------------------------------------------------------------------------------

/**
 * Twin of `aliasedActiveDealCountFilterSql`. That helper is a one-line alias of the reportability rule
 * and this is the same alias, kept under the server's name so a reader porting a query from a report
 * service finds the predicate they went looking for instead of concluding one does not exist.
 */
export function activeDealCountFilterSqlPredicate(identifierPath?: string): string {
  return reportableDealSqlPredicate(identifierPath);
}

/**
 * Twin of `aliasedBidBoardTerminalSql`: true when a deal is won/lost in the BID BOARD MIRROR, whatever
 * its CRM stage says. A Bid-Board-owned deal can be `closed_won` in `bid_board_stage_slug` while its
 * `stage_id` still points at estimating, so a population selected by CRM stage alone contains realized
 * work — which is the whole of C3.
 *
 * Unparenthesized, matching the server's string form; callers compose it (`AND NOT (…)`).
 */
export function bidBoardTerminalSqlPredicate(dealAlias: string): string {
  if (!SQL_IDENTIFIER_PATH.test(dealAlias)) {
    throw new Error(`Invalid Bid Board terminal SQL identifier: ${dealAlias}`);
  }
  return `COALESCE(${dealAlias}.bid_board_stage_slug, '') IN (${TERMINAL_STAGE_SLUG_SQL_LIST})`;
}

/**
 * The terminal CRM stage IDS, as a SUBSELECT rather than a caller-threaded array.
 *
 * `aliasedEffectiveOnHoldConditionSql(alias, terminalStageIds)` needs actual uuids, which a server
 * request has already loaded and a worker cron has not. Handing a raw-SQL caller a subselect closes that
 * gap without a round trip: `pipeline_stage_config` is a 38-row table that lives only in `public` (so the
 * qualification is required — tenant queries run with the office schema first on the search_path), and
 * Postgres hoists this to a one-shot InitPlan.
 */
export function terminalDealStageIdSubselectSql(): string {
  return `SELECT id FROM public.pipeline_stage_config WHERE slug IN (${TERMINAL_STAGE_SLUG_SQL_LIST})`;
}

/**
 * Twin of `aliasedEffectiveOnHoldConditionSql` — the TERMINAL-AWARE effective-on-hold condition.
 *
 * Stored `on_hold` OR — for an open deal only — a hold horizon date more than
 * CLOSE_TARGET_HOLD_HORIZON_DAYS CT-days out. Two independent terminal signals gate the far-out leg,
 * exactly as the drizzle twin does: the CRM stage id is won/lost, and the Bid Board mirror is terminal.
 * A realized deal must never be auto-parked by a stale forecast date.
 *
 * THE DEFAULT DIFFERS FROM THE DRIZZLE TWIN, DELIBERATELY. `aliasedEffectiveOnHoldConditionSql` defaults
 * `terminalStageIds` to `[]` and therefore emits NO stage-id leg unless a caller resolves and threads the
 * ids — so calling it the way the surrounding code reads drops half the terminal guard silently. A raw-SQL
 * caller has no id list to thread and would hit that trap every time, so here the safe form is what you
 * get for free: pass `null` for the legacy open-only shape, and only when you know the population has no
 * terminal rows.
 *
 * REQUIRED COLUMNS at the alias: `on_hold`, `stage_id`, `bid_board_stage_slug`, `bid_due_date`,
 * `expected_close_date`.
 */
export function effectiveOnHoldConditionSqlPredicate(
  identifierPath = "deals",
  terminalStageIdsSql: string | null = terminalDealStageIdSubselectSql(),
  options: { asOfDate?: string | null; bidDueDateSql?: string } = {}
): string {
  // closeTargetFarOutSqlPredicate validates too, but the stage-id and mirror columns below are built
  // here — the guard has to sit on every door that reaches raw SQL, not just the oldest one.
  if (!SQL_IDENTIFIER_PATH.test(identifierPath)) {
    throw new Error(`Invalid effective on-hold SQL identifier: ${identifierPath}`);
  }
  const guards: string[] = [];
  if (terminalStageIdsSql) {
    guards.push(`${identifierPath}.stage_id NOT IN (${terminalStageIdsSql})`);
  }
  guards.push(
    `COALESCE(${identifierPath}.bid_board_stage_slug, '') NOT IN (${TERMINAL_STAGE_SLUG_SQL_LIST})`
  );
  const stored = `COALESCE(${identifierPath}.on_hold, false) = true`;
  const farOutForOpen =
    `${guards.join(" AND ")} AND (${closeTargetFarOutSqlPredicate(identifierPath, options)})`;
  return `(${stored} OR (${farOutForOpen}))`;
}
