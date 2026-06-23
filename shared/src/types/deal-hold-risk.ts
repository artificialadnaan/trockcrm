/**
 * THE single source of truth for the close-target-driven at-risk SUPPRESSION rule. Shared by the deal
 * activity/SLA surface and kanban cards (client TS), and the deal/at-risk APIs, dashboards, reports,
 * and worker stale-deal alerts (server TS) — every surface that computes at-risk via [[at-risk]]
 * `getDealAtRiskResult`.
 *
 * The "close target" is the deal's `expected_close_date` (reused, not a new column). While that date
 * is today-or-future, the stage-age at-risk verdict is suppressed ("don't nag until the target
 * passes"); once it passes (or is null/past), normal stage-age at-risk applies again.
 *
 * Derived hold horizon: `CLOSE_TARGET_HOLD_HORIZON_DAYS` (bottom of file) is the threshold at which a
 * close target is far enough out that the deal reads as "effectively on hold" — the basis for the deals
 * On Hold filter pill (and, in a follow-up, value-zeroing). This is DISTINCT from the at-risk
 * SUPPRESSION above: suppression quiets the stage-age nag for ANY today-or-future target; the hold
 * horizon is the much-farther-out (90-day) threshold. On-hold also remains the explicit, stored
 * `deals.on_hold` toggle ([[deal-reporting]]); the derived horizon is an OR-leg on top of it, never a
 * replacement.
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
