import type { DateRangePreset } from "@/hooks/use-director-dashboard";

// Hard-coded company revenue goal. There is no goal-setting UI yet; this is the single
// source of truth for the Director "Forecast vs goal" / Pace tiles. To change the goal,
// edit ANNUAL_REVENUE_GOAL here, or later swap this module for a real per-period store.
// Even splits, no seasonal weighting.
export const ANNUAL_REVENUE_GOAL = 33_000_000;
export const QUARTERLY_REVENUE_GOAL = ANNUAL_REVENUE_GOAL / 4; // 8,250,000
export const MONTHLY_REVENUE_GOAL = ANNUAL_REVENUE_GOAL / 12; // 2,750,000

// Pace band: Closed within +/- this fraction of the prorated expected-to-date reads as
// "On track"; clearly above is "Ahead", clearly below is "Behind".
export const PACE_ON_TRACK_BAND = 0.1;

export type Pace = "Behind" | "On track" | "Ahead";

// Full target for the selected period (annual for YTD, quarter for QTD, month for MTD).
// Historical complete periods map to the matching granularity; custom falls back to annual.
export function periodRevenueTarget(preset: DateRangePreset): number {
  switch (preset) {
    case "mtd":
    case "last_month":
      return MONTHLY_REVENUE_GOAL;
    case "qtd":
    case "last_quarter":
      return QUARTERLY_REVENUE_GOAL;
    default: // ytd, last_year, custom
      return ANNUAL_REVENUE_GOAL;
  }
}

const DAY_MS = 86_400_000;

// Whole-day index for a UTC calendar date, so day arithmetic is DST-free.
function utcDayIndex(year: number, monthIndex: number, day: number): number {
  return Math.floor(Date.UTC(year, monthIndex, day) / DAY_MS);
}

// Fraction of the CURRENT period elapsed by `now`, counted in whole days and inclusive of
// today (so the last day of the period yields 1). YTD uses a fixed 365-day denominator per
// spec; QTD/MTD use the actual number of days in the quarter/month. Historical/complete
// presets (last_*, custom) return 1 (the whole period has elapsed).
export function periodElapsedFraction(preset: DateRangePreset, now: Date): number {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();

  if (preset === "mtd") {
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return day / daysInMonth;
  }
  if (preset === "qtd") {
    const quarterStartMonth = Math.floor(month / 3) * 3;
    const daysInQuarter =
      utcDayIndex(year, quarterStartMonth + 3, 1) - utcDayIndex(year, quarterStartMonth, 1);
    const dayOfQuarter = utcDayIndex(year, month, day) - utcDayIndex(year, quarterStartMonth, 1) + 1;
    return dayOfQuarter / daysInQuarter;
  }
  if (preset === "ytd") {
    const dayOfYear = utcDayIndex(year, month, day) - utcDayIndex(year, 0, 1) + 1;
    return dayOfYear / 365;
  }
  return 1;
}

// Revenue we would expect by `now` to be exactly on pace for the period's full target.
export function periodExpectedToDate(preset: DateRangePreset, now: Date): number {
  return periodRevenueTarget(preset) * Math.min(1, periodElapsedFraction(preset, now));
}

// Behind / On track / Ahead from Closed vs the prorated expected-to-date.
export function derivePace(closed: number, expectedToDate: number): Pace {
  if (expectedToDate <= 0) return "On track";
  const ratio = closed / expectedToDate;
  if (ratio >= 1 + PACE_ON_TRACK_BAND) return "Ahead";
  if (ratio < 1 - PACE_ON_TRACK_BAND) return "Behind";
  return "On track";
}
