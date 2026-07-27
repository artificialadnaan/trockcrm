/**
 * THE single source of truth for close-target-driven at-risk suppression and derived hold behavior. Shared
 * by the deal activity/SLA surface and kanban cards (client TS), and the deal/at-risk APIs, dashboards,
 * reports, and worker stale-deal alerts (server TS) — every surface that computes at-risk via [[at-risk]]
 * `getDealAtRiskResult`.
 *
 * The "close target" is the deal's `expected_close_date` (reused, not a new column). While that date
 * is today-or-future, the stage-age at-risk verdict is suppressed ("don't nag until the target
 * passes"); once it passes (or is null/past), normal stage-age at-risk applies again.
 *
 * Derived hold horizon: `CLOSE_TARGET_HOLD_HORIZON_DAYS` (bottom of file) is the threshold at which the
 * deal's hold horizon date is far enough out that it reads as "effectively on hold" — the basis for the
 * deals On Hold filter pill, value-zeroing, and at-risk exclusion. That horizon date is the close target
 * in every stage EXCEPT the genuine 'estimating' stage, where it is the deal's BID due date (2026-07-27;
 * see resolveHoldHorizonDay). This is DISTINCT from the shorter pending close-target suppression above,
 * which callers opt into for detail-style SLA messaging and which stays keyed on `expected_close_date` in
 * every stage. On-hold also remains the explicit, stored `deals.on_hold` toggle ([[deal-reporting]]); the
 * derived horizon is an OR-leg on top of it, never a replacement.
 *
 * Day boundary: the predicate takes an injected `now: Date` and resolves "today" to the
 * America/Chicago calendar day — the SAME anchor the forecast SQL uses ((now() AT TIME ZONE
 * 'America/Chicago')::date) — so card/header verdicts and report dates never disagree by a day.
 */

export interface CloseTargetInput {
  /** The deal's close target = its `expected_close_date` (a calendar DATE; string "YYYY-MM-DD" or Date). */
  expectedCloseDate?: string | Date | null;
  /** The reference instant; "today" is its America/Chicago calendar day. */
  now: Date;
}

/** "YYYY-MM-DD" for the America/Chicago calendar day of `now` (DST-safe via Intl). */
function chicagoCalendarDay(now: Date): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Normalize a close-target value to its "YYYY-MM-DD" calendar day, or null if absent/unparseable. */
function calendarDay(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!match) return null;
  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  // Reject impossible dates (e.g. 2026-02-31, 2026-13-01) that Date.UTC would silently roll over,
  // which would otherwise corrupt the day delta and flip a suppression verdict.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return `${y}-${m}-${d}`;
}

/** Whole calendar days between two "YYYY-MM-DD" days (to − from), via UTC midnights (DST-immune). */
function calendarDayDiff(fromYmd: string, toYmd: string): number {
  const utc = (ymd: string) =>
    Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)));
  return Math.round((utc(toYmd) - utc(fromYmd)) / 86_400_000);
}

/**
 * Whole calendar days from CT-today to the close target (positive = future, negative = past),
 * or null when there is no parseable target.
 */
export function daysUntilCloseTarget(
  expectedCloseDate: string | Date | null | undefined,
  now: Date
): number | null {
  const target = calendarDay(expectedCloseDate);
  if (target == null) return null;
  return calendarDayDiff(chicagoCalendarDay(now), target);
}

/**
 * At-risk suppression: a today-or-future close target quiets the stage-age at-risk nag until it
 * passes. Returns false for a null, unparseable, or already-past target (normal at-risk applies).
 */
export function isAtRiskSuppressedByCloseTarget({ expectedCloseDate, now }: CloseTargetInput): boolean {
  const days = daysUntilCloseTarget(expectedCloseDate, now);
  return days != null && days >= 0;
}

/**
 * The close-target hold horizon (CT-calendar days). A deal whose `expected_close_date` is more than
 * this many days out reads as "effectively on hold" — an OR-leg on top of the stored `deals.on_hold`
 * flag. Shared by the On Hold filter's SQL predicate ([[deal-reporting]] `effectiveOnHoldSqlPredicate`)
 * and the TS twin so the day-math can never drift between SQL and TS. 90 days ≈ a full quarter past the
 * near-term forecast windows (30/60/90).
 */
export const CLOSE_TARGET_HOLD_HORIZON_DAYS = 90;

export interface EffectiveOnHoldInput {
  /** The stored `deals.on_hold` flag. */
  onHold?: boolean | null;
  /** The deal's close target = its `expected_close_date`. */
  expectedCloseDate?: string | Date | null;
  /**
   * The deal's BID due date (`deals.bid_due_date`). Read ONLY when `isEstimating` is true; ignored in
   * every other stage. A Date is resolved to its UTC calendar day, matching the SQL twin's
   * `(bid_due_date AT TIME ZONE 'UTC')::date` — the column is a timestamptz stored at UTC midnight.
   */
  bidDueDate?: string | Date | null;
  /**
   * True only for the genuine normal-route 'estimating' stage (route-aware: includes the legacy
   * estimate_in_progress alias, EXCLUDES service_estimating). In that stage the auto-park horizon is
   * measured from the BID due date instead of the close target — see resolveHoldHorizonDay. Callers that
   * cannot classify the stage leave it unset and keep today's close-target rule.
   */
  isEstimating?: boolean;
  /** The reference instant; "today" is its America/Chicago calendar day. */
  now: Date;
  /**
   * Whether the deal is already TERMINAL (won OR lost). The far-future auto-park leg applies to OPEN
   * pipeline value only — a deal can be won EARLY (its won path stamps the won date but leaves the
   * forecast date far out) and a lost deal is a historical bid whose value is preserved for Loss
   * Analysis; in both cases the value is realized/preserved, NOT a stale forecast to zero. So a terminal
   * deal is effectively on hold ONLY via the explicit stored flag, never the horizon. Mirrors the server,
   * where won-value SQL helpers + terminal columns zero on stored on_hold only.
   */
  isTerminal?: boolean;
}

/**
 * The date the far-out auto-park horizon is measured against — the TS twin of [[deal-reporting]]
 * `holdHorizonDateSql`, and the ONLY place the two rules are chosen between.
 *
 * Everywhere except the genuine 'estimating' stage that is `expected_close_date`. In estimating it is the
 * BID due date (Adnaan, 2026-07-27): estimating work has to stay relevant and quick, and the bid deadline
 * is almost always nearer than the project close target, so a deal whose bid is not due for another
 * quarter parks even though its close date looks near-term.
 *
 * A NULL/unparseable bid due date falls back to `expected_close_date` rather than never auto-parking:
 * `bid_due_date` is NULL on 91% of deals, and "no bid due date ⇒ never park" would let one missing field
 * release $4.39M of far-out estimating pipeline back into reported dollars on prod — the stale-forecast
 * inflation auto-on-hold exists to prevent. The fallback is strictly conservative: for a null-bid row it
 * reproduces today's behaviour exactly.
 *
 * Coalesces on the PARSED calendar day, not on the raw value, so it matches the SQL `COALESCE` over a real
 * date column even when a caller hands us an unparseable bid string.
 */
function resolveHoldHorizonDay(
  { expectedCloseDate, bidDueDate, isEstimating }: Pick<
    EffectiveOnHoldInput,
    "expectedCloseDate" | "bidDueDate" | "isEstimating"
  >
): string | null {
  if (isEstimating === true) {
    const bidDay = calendarDay(bidDueDate);
    if (bidDay != null) return bidDay;
  }
  return calendarDay(expectedCloseDate);
}

/**
 * "Effectively on hold" = the stored `on_hold` flag OR (for an OPEN deal) a hold horizon date more than
 * CLOSE_TARGET_HOLD_HORIZON_DAYS CT-days out (auto-park). The horizon date is the close target in every
 * stage but 'estimating', where it is the bid due date (resolveHoldHorizonDay). The TS twin of
 * [[deal-reporting]] `effectiveOnHoldSqlPredicate`: STRICTLY greater-than the horizon, mirroring the SQL's
 * `> ... + INTERVAL '90 days'`, so a deal exactly 90 days out is NOT yet held in either world. Drives
 * client value-zeroing (getEffectiveDealValue), the On Hold badge, and at-risk exclusion.
 */
export function isDealEffectivelyOnHold({
  onHold,
  expectedCloseDate,
  bidDueDate,
  isEstimating,
  now,
  isTerminal,
}: EffectiveOnHoldInput): boolean {
  if (onHold === true) return true;
  // A terminal (won/lost) deal is realized/preserved — never auto-parked by a stale forecast date (only
  // its stored flag holds it).
  if (isTerminal === true) return false;
  const days = daysUntilCloseTarget(
    resolveHoldHorizonDay({ expectedCloseDate, bidDueDate, isEstimating }),
    now
  );
  return days != null && days > CLOSE_TARGET_HOLD_HORIZON_DAYS;
}
