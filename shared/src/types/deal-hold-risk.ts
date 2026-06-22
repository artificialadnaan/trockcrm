/**
 * THE single source of truth for the close-target-driven hold + at-risk rules. Shared by the deal
 * activity/SLA surface and kanban cards (client TS), the deal/at-risk APIs and dashboards (server TS),
 * and — via the SQL twins added alongside their first consumer — the forecast ladder and reports.
 *
 * It composes on top of the two existing models rather than forking them:
 *   - the stored on-hold model ([[deal-reporting]] `isDealActivelyOnHold` / `reportableDealSqlPredicate`)
 *   - the stage-age SLA at-risk model ([[at-risk]] `getAtRiskResult`)
 *
 * The "close target" is the deal's `expected_close_date` (reused, not a new column), so the target,
 * the auto-on-hold trigger, and the forecast-ladder bucket all key off ONE date and cannot drift:
 *
 *   - A future close target MORE than {@link AUTO_ON_HOLD_TARGET_DAYS} days out puts the deal in a
 *     DERIVED "auto on hold" state. We never write `deals.on_hold` for this — it is computed — so the
 *     manual hold-time accumulator is untouched. Crossing the 90-day line flips the state in BOTH
 *     directions automatically as the date (or `now`) moves.
 *   - A future close target AT OR WITHIN the window suppresses the stage-age at-risk verdict
 *     ("don't nag until the target passes"). Once the date passes (or is null/past), normal stage-age
 *     at-risk applies again.
 *
 * Day boundary: the TS predicates take an injected `now: Date` and resolve "today" to the
 * America/Chicago calendar day — the SAME anchor the forecast SQL uses ((now() AT TIME ZONE
 * 'America/Chicago')::date) — so the card/header verdicts and the report SQL never disagree by a day.
 */

/** A future close target strictly beyond this many days auto-holds the deal (and clears at-risk). */
export const AUTO_ON_HOLD_TARGET_DAYS = 90;

export interface CloseTargetInput {
  /** The deal's close target = its `expected_close_date` (a calendar DATE; string "YYYY-MM-DD" or Date). */
  expectedCloseDate?: string | Date | null;
  /** The reference instant; "today" is its America/Chicago calendar day. */
  now: Date;
}

interface EffectiveOnHoldInput {
  onHold?: boolean | null;
  expectedCloseDate?: string | Date | null;
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
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
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

/** Derived auto-on-hold: the close target is strictly more than {@link AUTO_ON_HOLD_TARGET_DAYS} out. */
export function isAutoOnHoldByCloseTarget({ expectedCloseDate, now }: CloseTargetInput): boolean {
  const days = daysUntilCloseTarget(expectedCloseDate, now);
  return days != null && days > AUTO_ON_HOLD_TARGET_DAYS;
}

/**
 * At-risk suppression: a today-or-future close target within the {@link AUTO_ON_HOLD_TARGET_DAYS}
 * window quiets the stage-age at-risk nag until it passes. (Targets beyond the window are handled by
 * {@link isAutoOnHoldByCloseTarget}, which clears at-risk via the on-hold path instead.)
 */
export function isAtRiskSuppressedByCloseTarget({ expectedCloseDate, now }: CloseTargetInput): boolean {
  const days = daysUntilCloseTarget(expectedCloseDate, now);
  return days != null && days >= 0 && days <= AUTO_ON_HOLD_TARGET_DAYS;
}

/** Effective on-hold = stored `deals.on_hold` OR the derived >90-day auto-hold. */
export function isDealEffectivelyOnHold(deal: EffectiveOnHoldInput, now: Date): boolean {
  return deal.onHold === true || isAutoOnHoldByCloseTarget({ expectedCloseDate: deal.expectedCloseDate, now });
}
