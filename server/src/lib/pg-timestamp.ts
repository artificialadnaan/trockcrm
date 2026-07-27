/**
 * The bounds Postgres applies to a timestamp literal, in ONE place.
 *
 * ─── Why this exists ────────────────────────────────────────────────────────────────────────────────
 *
 * Two independent hand-rolled validators in the files module each decide whether a caller-supplied
 * string is a timestamp Postgres will accept, because both feed values into a `::timestamptz` cast where
 * a rejection surfaces as an unmapped 500 rather than the documented "drop the invalid filter":
 *
 *   - `parseFileDateParam` (files/file-constants.ts) — the `?dateFrom=` / `?dateTo=` query filters.
 *   - `isPostgresTimestampText` (files/feed-service.ts) — the keyset cursor's sortValue.
 *
 * They were written separately and disagreed. The year-zero hole was found and closed in the cursor
 * validator, and the *same* hole survived in the date-param validator because nobody asked who else
 * casts. A second hole — timezone offsets past Postgres's limit — existed only in the date-param
 * validator, and the cursor validator avoided it by accident: its regex happens to bound the offset by
 * construction, not because anyone reasoned about the range.
 *
 * Two validators, two different answers, one of them wrong in each direction. So the BOUNDS live here
 * and both call in. A future input path that needs to ask the same question cannot inherit a third
 * answer.
 *
 * ─── The bounds, measured rather than assumed ───────────────────────────────────────────────────────
 *
 * Swept against a real `::timestamptz` cast (PGlite), 20,162 candidates covering a year sweep in both
 * the date-only and datetime forms, a full timezone-offset sweep, fractional-second widths, and the
 * `24:00:00` / `23:59:60` shapes. Postgres rejected 55:
 *
 *   - **2** for year `0000` — one per form. Postgres uses the proleptic Gregorian calendar, which has no
 *     year zero (1 BC is followed by 1 AD). JavaScript's `Date` *does* have one, accepts it, and
 *     round-trips it faithfully, so an `toISOString()` comparison waves it through.
 *   - **53** for a timezone offset beyond ±15:59 (`+16:00`, `+16:30`, `+16:59`, …). `Date.parse` accepts
 *     offsets out to ±23:59; Postgres caps at ±15:59.
 *
 * Nothing else in that space diverges, so these two checks close the class rather than a symptom.
 */

/** Postgres has no year zero. Every other 4-digit year in range is fine. */
export function isPostgresYear(year: string): boolean {
  return /^\d{4}$/.test(year) && year !== "0000";
}

/** Largest UTC offset Postgres will accept, in minutes (±15:59). `Date.parse` allows ±23:59. */
export const PG_MAX_TZ_OFFSET_MINUTES = 15 * 60 + 59;

/**
 * Whether a trailing timezone designator is one Postgres accepts.
 *
 * `undefined` / empty (no designator at all) and `Z` are both fine. Anything else must be `±HH`,
 * `±HH:MM` or `±HHMM` within ±15:59.
 */
export function isPostgresTzOffset(offset: string | undefined | null): boolean {
  if (!offset || offset === "Z" || offset === "z") return true;
  const match = /^([+-])(\d{2}):?(\d{2})?$/.exec(offset);
  if (!match) return false;
  const [, , hours, minutes] = match;
  const total = Number(hours) * 60 + Number(minutes ?? "0");
  return Number.isFinite(total) && total <= PG_MAX_TZ_OFFSET_MINUTES;
}

/**
 * Whether `YYYY-MM-DD` names a real calendar date Postgres will accept.
 *
 * The round-trip is what rejects calendar overflow (`2026-02-30`), which no regex can express —
 * `Date.parse` silently rolls it to March 2 and reports success. The year check is separate because the
 * round-trip is faithful for year zero and therefore cannot catch it.
 */
export function isPostgresCalendarDate(year: string, month: string, day: string): boolean {
  if (!isPostgresYear(year)) return false;
  const probe = new Date(`${year}-${month}-${day}T00:00:00Z`);
  return !Number.isNaN(probe.getTime()) && probe.toISOString().slice(0, 10) === `${year}-${month}-${day}`;
}
