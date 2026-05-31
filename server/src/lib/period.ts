// F1 -- the SINGLE canonical server-side period definition. Sunday-Saturday weeks (PR #539),
// anchored in the BUSINESS timezone (America/Chicago). Imported by the dashboard, the reports suite,
// and YELLOW's director-campaign Batch B -- do NOT define a parallel one (a second definition
// recreates the D-17/D-18 dashboard-vs-reports reconcile failure). "This week" is the office's Central
// week: F1 is CANONICAL and the client resolver (toDatePresetRange / resolveDatePreset) is aligned TO it
// (also Central-anchored), so they produce identical boundaries even at the cross-tz boundary (a Pacific
// user late Saturday, while CT is already Sunday, is in the new CT week). Proven by the matching boundary
// cases in server/tests/lib/period.test.ts and client/src/lib/pipeline-terminal-filters.test.ts.

import { sql, type SQL } from "drizzle-orm";

export const BUSINESS_TIMEZONE = "America/Chicago";

export type WeekMode = "to_date" | "completed";

// Today's date (YYYY-MM-DD) in the business tz -- DST-aware via Intl, matching the dashboard's
// `new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" })` pattern.
function businessDate(now: Date): string {
  return now.toLocaleDateString("en-CA", { timeZone: BUSINESS_TIMEZONE });
}

// Calendar arithmetic on a YYYY-MM-DD string. Parse at UTC NOON so adding/subtracting days never
// trips a DST midnight boundary (the time-of-day is discarded; only the date is returned).
function shiftDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dayOfWeek(isoDate: string): number {
  return new Date(`${isoDate}T12:00:00Z`).getUTCDay(); // 0 = Sunday
}

/**
 * The canonical Sunday-Saturday week period, business-tz anchored.
 * - "to_date":   from = most-recent Sunday, to = today  (the LIVE dashboard "week-to-date").
 * - "completed": the full PRIOR Sun-Sat box -- from = prior Sunday, to = prior Saturday  (the
 *   Monday-meeting REPORTS week).
 * Returns date-only strings (YYYY-MM-DD), ready to feed getWonCloseSummary({from,to}) and date filters.
 */
export function getWtdPeriod(mode: WeekMode, now: Date = new Date()): { from: string; to: string } {
  const today = businessDate(now);
  const thisSunday = shiftDays(today, -dayOfWeek(today));
  if (mode === "to_date") {
    return { from: thisSunday, to: today };
  }
  return { from: shiftDays(thisSunday, -7), to: shiftDays(thisSunday, -1) };
}

/**
 * SQL fragment that buckets a timestamp expression into its Sunday-anchored week-start DATE, in the
 * business tz -- for the weekly trend surfaces (e.g. the 8-week Momentum Lanes). Postgres
 * date_trunc('week') is Monday-based, so we shift +1 day, truncate, then -1 day to land on Sunday,
 * matching getWtdPeriod's anchor. Returns a Drizzle SQL fragment (interpolate directly into a sql``
 * template -- NOT a string, which would be bound as a parameter and silently break grouping).
 * `tsExpr` must be a trusted timestamptz column expression (it is emitted as raw SQL).
 */
export function sundayWeekBucketSql(tsExpr: string): SQL {
  return sql.raw(
    `(date_trunc('week', ((${tsExpr}) AT TIME ZONE '${BUSINESS_TIMEZONE}') + interval '1 day') - interval '1 day')::date`
  );
}
