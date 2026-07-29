import type { DepartmentMetric, WeekMode } from "./api/endpoints/reports";

/**
 * The display decisions the showcase screen makes, kept out of the screen.
 *
 * Same rule as `prospect-state.ts`: anything that reads a number and decides what to SAY about it is a
 * decision, and a decision assembled in JSX is one nothing can test. Two of these have already been got
 * wrong on the web — a delta that shows for a period where it has no meaning, and a placeholder
 * rendered as a real zero.
 */

/** The period toggle, in the order it reads. Mirrors WeekMode in server/src/lib/period.ts:14. */
export const WEEK_MODES: readonly { key: WeekMode; label: string }[] = [
  { key: "to_date", label: "This week" },
  { key: "completed", label: "Last week" },
  { key: "mtd", label: "MTD" },
  { key: "ytd", label: "YTD" },
];

/**
 * Is a week-over-week delta meaningful for this period?
 *
 * NO for month- and year-to-date. The web hides it there via `shouldShowWowDelta` in
 * `client/src/.../week-mode.ts`, because "up 3 from last week" against a year-to-date total is
 * comparing a year to a week — a number that is arithmetically fine and means nothing. Mirrored rather
 * than imported: mobile-crm is outside the workspace and cannot reach client/, which is the same
 * constraint that makes this a MIRROR the way `ESTIMATING_STAGE_SLUGS` is.
 */
export function showsWowDelta(mode: WeekMode): boolean {
  return mode === "to_date" || mode === "completed";
}

/** What a department's count should read as — `null` is a placeholder, never a zero. */
export function departmentCountLabel(metric: Pick<DepartmentMetric, "count" | "deferred">): string {
  if (metric.deferred || metric.count === null) return "—";
  return String(metric.count);
}

export type DeltaTone = "up" | "down" | "flat";

/**
 * The delta chip, or null when there should not be one.
 *
 * Null in three distinct cases, and they are genuinely different: the period makes the comparison
 * meaningless, the department has no number to compare, or the server sent no delta. Collapsing them
 * into "falsy" is how a placeholder ends up rendering "+0".
 */
export function deltaChip(
  metric: Pick<DepartmentMetric, "deltaCountWoW" | "deferred">,
  mode: WeekMode,
): { label: string; tone: DeltaTone } | null {
  if (!showsWowDelta(mode)) return null;
  if (metric.deferred || metric.deltaCountWoW === null) return null;
  const d = metric.deltaCountWoW;
  if (d === 0) return { label: "0", tone: "flat" };
  return { label: d > 0 ? `+${d}` : String(d), tone: d > 0 ? "up" : "down" };
}

/**
 * Bar heights for an eight-week sparkline, as fractions of the tallest week.
 *
 * Drawn with plain Views rather than a chart library — there is no `react-native-svg` and no
 * `react-native-reanimated` in this app, and eight bars do not justify adding either.
 *
 * Scaled to the MAX, not to a fixed ceiling, because the shape is the message: a rep reads whether the
 * line is climbing, not what week four measured. An all-zero series returns all zeros rather than
 * dividing by it — eight bars at full height would say "steady and strong" about a department that did
 * nothing.
 */
export function sparklineHeights(series: readonly number[]): number[] {
  const max = series.reduce((m, v) => (Number.isFinite(v) && v > m ? v : m), 0);
  if (max <= 0) return series.map(() => 0);
  return series.map((v) => (Number.isFinite(v) && v > 0 ? v / max : 0));
}

/**
 * Money at a glance: "$1.2M", "$412k", "$0".
 *
 * The full figure is what `formatMoney` is for; this is for a headline read at arm's length, where nine
 * digits are noise. Negative is kept — a deductive change order is real money going the other way.
 */
export function compactMoney(amount: number): string {
  if (!Number.isFinite(amount)) return "—";
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  if (abs >= 1_000_000) return `${sign}$${trimZero(abs / 1_000_000)}M`;
  if (abs >= 1_000) return `${sign}$${trimZero(abs / 1_000)}k`;
  return `${sign}$${Math.round(abs)}`;
}

/** One decimal, but only when it says something: 1.2M keeps the .2, 3.0M does not. */
function trimZero(n: number): string {
  const one = n.toFixed(1);
  return one.endsWith(".0") ? one.slice(0, -2) : one;
}
