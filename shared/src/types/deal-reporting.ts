import { CLOSE_TARGET_HOLD_HORIZON_DAYS } from "./deal-hold-risk.js";
import { GENUINE_ESTIMATING_DEAL_STAGE_SLUGS } from "./workflow.js";

type DealReportabilityLike = {
  onHold?: boolean | null;
};

const SQL_IDENTIFIER_PATH = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/;

// The America/Chicago "today" anchor — the SAME boundary the forecast SQL and the at-risk close-target
// rule use, so the On Hold filter and the forecast never disagree by a day.
const CT_TODAY_SQL = "(now() AT TIME ZONE 'America/Chicago')::date";

// Compile-time constants from the workflow module, never user input — but quote-escaped anyway so this
// stays injection-proof if the slug list is ever sourced from data.
const GENUINE_ESTIMATING_STAGE_SLUG_SQL_LIST = GENUINE_ESTIMATING_DEAL_STAGE_SLUGS.map(
  (slug) => `'${slug.replace(/'/g, "''")}'`
).join(", ");

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
 * "Effectively on hold" = the stored `on_hold` flag OR a close target far enough out (more than
 * CLOSE_TARGET_HOLD_HORIZON_DAYS CT-days) that the deal is treated as parked. This is what the deals
 * "On Hold" filter pill matches; the horizon constant is shared with the at-risk module so the SQL day
 * boundary and the TS day-math can never drift. Pure string builder (no drizzle dep), consumed via
 * `sql.raw` like reportableDealSqlPredicate.
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
function genuineEstimatingStageSqlPredicate(identifierPath?: string): string {
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
 */
function holdHorizonDateSql(identifierPath?: string): string {
  const column = (name: string) => (identifierPath ? `${identifierPath}.${name}` : name);
  return (
    `CASE WHEN ${genuineEstimatingStageSqlPredicate(identifierPath)} ` +
    `THEN COALESCE((${column("bid_due_date")} AT TIME ZONE 'UTC')::date, ${column("expected_close_date")}) ` +
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
export function closeTargetFarOutSqlPredicate(identifierPath?: string): string {
  if (identifierPath && !SQL_IDENTIFIER_PATH.test(identifierPath)) {
    throw new Error(`Invalid effective on-hold SQL identifier: ${identifierPath}`);
  }
  // The horizon expression is emitted twice rather than aliased once — this is a pure string builder with
  // no CTE/LATERAL to hang a name on. The `IS NOT NULL` leg is NOT redundant with the comparison: callers
  // negate this predicate (`NOT (...)` in the deals "active" status filter), and under three-valued logic
  // `NOT (NULL > x)` is NULL (row dropped) while `NOT (NULL IS NOT NULL AND ...)` is TRUE (row kept). A
  // deal with no horizon date must read as ACTIVE, not vanish.
  const horizonDate = holdHorizonDateSql(identifierPath);
  return (
    `(${horizonDate}) IS NOT NULL AND ` +
    `(${horizonDate}) > ${CT_TODAY_SQL} + INTERVAL '${CLOSE_TARGET_HOLD_HORIZON_DAYS} days'`
  );
}
