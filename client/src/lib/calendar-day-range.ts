/**
 * Converts the `YYYY-MM-DD` value of an `<input type="date">` into the instant bounds of that calendar
 * day IN THE USER'S OWN TIMEZONE.
 *
 * The bug this replaces, which shipped on the Photos tab long before this change set and was about to
 * be copied onto the Projects tab:
 *
 *     const end = new Date("2026-07-27");   // ISO date-only -> parsed as UTC midnight
 *     end.setHours(23, 59, 59, 999);        // ...then mutated in LOCAL time
 *
 * Those two lines disagree about which timezone they are in. In US Central, `new Date("2026-07-27")` is
 * 2026-07-26 19:00 local, so `setHours(23, …)` lands on 2026-07-26 23:59:59 local — the evening BEFORE
 * the day the user picked. Selecting the same start and end date therefore asked the server for roughly
 * 2026-07-27T00:00Z .. 2026-07-27T04:59Z: a five-hour window over the previous local evening, which
 * silently returns few or no photos for a day that plainly has them.
 *
 * Both bounds are built from the SAME parse, in local time, so "27 July" means the user's 27 July from
 * 00:00:00.000 to 23:59:59.999 — and `toISOString()` then hands the server the correct instants.
 *
 * Local time is the right frame here: these filters sit next to timestamps rendered in the browser's
 * timezone, so a day means the day the user is looking at. (The alternative — send raw calendar dates
 * and pick a timezone server-side — would be defensible too, but it is a server contract change and
 * every existing caller of these endpoints sends instants.)
 */

/** Parses `YYYY-MM-DD` into local Y/M/D parts. Returns null for anything else. */
function parseCalendarDay(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day] = match;
  return { year: Number(year), month: Number(month), day: Number(day) };
}

/** First instant of the given calendar day, local time, as an ISO string. */
export function startOfCalendarDayIso(value: string): string | undefined {
  const parts = parseCalendarDay(value);
  if (!parts) return undefined;
  // Month is 0-based in this constructor, which is also the one that interprets its arguments as LOCAL.
  return new Date(parts.year, parts.month - 1, parts.day, 0, 0, 0, 0).toISOString();
}

/** Last instant of the given calendar day, local time, as an ISO string. */
export function endOfCalendarDayIso(value: string): string | undefined {
  const parts = parseCalendarDay(value);
  if (!parts) return undefined;
  return new Date(parts.year, parts.month - 1, parts.day, 23, 59, 59, 999).toISOString();
}
