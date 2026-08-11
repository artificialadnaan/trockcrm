import type { DepartmentMetric, EvidenceMetric, WeekMode } from "./api/endpoints/reports";

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
  // "WoW" travels WITH the number, matching the web's shared DeltaChip (evidence-kit.tsx:42, whose
  // suffix defaults to exactly this). A bare "+3" beside a count reads as a target variance, a
  // remaining total, or another unlabelled figure — every reading except the one meant.
  if (d === 0) return { label: "0 WoW", tone: "flat" };
  return { label: `${d > 0 ? `+${d}` : d} WoW`, tone: d > 0 ? "up" : "down" };
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
  // The suffix is chosen AFTER rounding, not before. Picking it first meant 999_999 rounded to 1000
  // inside its own unit and rendered "$1000k" — four digits, which is exactly the noise this exists to
  // remove, at the boundary a real report total is most likely to sit on.
  for (const [unit, suffix] of [
    [1_000_000, "M"],
    [1_000, "k"],
  ] as const) {
    if (abs >= unit) {
      const scaled = abs / unit;
      const rounded = Number(scaled.toFixed(1));
      if (rounded >= 1000 && unit === 1_000) return `${sign}$${trimZero(abs / 1_000_000)}M`;
      return `${sign}$${trimZero(rounded)}${suffix}`;
    }
  }
  const whole = Math.round(abs);
  return whole >= 1000 ? `${sign}$${trimZero(whole / 1_000)}k` : `${sign}$${whole}`;
}

/** One decimal, but only when it says something: 1.2M keeps the .2, 3.0M does not. */
function trimZero(n: number): string {
  const one = n.toFixed(1);
  return one.endsWith(".0") ? one.slice(0, -2) : one;
}

/**
 * The value bases actually in play, attributed to the metrics that use them.
 *
 * Won is measured awarded-first while Sent and Estimated are a best current estimate, so three figures
 * side by side can be counted three different ways. The screen printed only Won's label underneath all
 * three, which reads as one caption for the row — the most confident possible version of the wrong
 * thing.
 *
 * Deduped, because the common case is two bases across three metrics and repeating "Best current
 * estimate" twice is noise. A single shared basis returns one unattributed line, since naming all three
 * metrics to say the same thing about each is worse than saying it once.
 */
export function heroBasisLines(
  metrics: readonly { label: string; basisLabel: string }[],
): string[] {
  const byBasis = new Map<string, string[]>();
  for (const m of metrics) {
    const basis = m.basisLabel?.trim();
    if (!basis) continue;
    byBasis.set(basis, [...(byBasis.get(basis) ?? []), m.label]);
  }
  if (byBasis.size === 0) return [];
  if (byBasis.size === 1) return [...byBasis.keys()];
  return [...byBasis.entries()].map(([basis, labels]) => `${labels.join(" & ")}: ${basis}`);
}

/**
 * Is the LAST sparkline bucket still in progress?
 *
 * `computeWeeklyTrend` anchors the final bucket to the current Sunday and caps it at today, so in every
 * mode except "completed" it is a partial week. Drawn like the seven whole weeks beside it, a Tuesday
 * renders as a cliff — the chart reports a collapse in activity that is really just the week being two
 * days old. The web reaches the same conclusion from the same field (variants.tsx:94).
 */
export function lastWeekIsInProgress(mode: WeekMode): boolean {
  return mode !== "completed";
}

/**
 * The eight-week shape, in a sentence, for anyone who cannot see the bars.
 *
 * The chart is hidden from the accessibility tree because unlabelled bars are noise — but the claim
 * that the count and the delta already carry it was wrong. Rising, falling and volatile histories can
 * share an endpoint AND a one-week delta, and the trend is one of the things this screen exists to
 * show. So it is described rather than dropped.
 *
 * Endpoints plus a direction, not eight numbers read aloud: the shape is the message. A partial final
 * week is called out, since otherwise the summary would report the same false decline the bars did.
 */
export function sparklineSummary(
  series: readonly number[],
  options: { lastInProgress: boolean },
): string | null {
  const weeks = series.filter((v) => Number.isFinite(v));
  if (weeks.length < 2) return null;
  // The partial week cannot be compared with whole ones, so the DIRECTION is read off the completed
  // history and the in-progress figure is reported separately.
  const compared = options.lastInProgress ? weeks.slice(0, -1) : weeks;
  if (compared.length < 2) return null;

  const first = compared[0];
  const last = compared[compared.length - 1];
  const direction = last > first ? "rising" : last < first ? "falling" : "level";
  const head = `${compared.length}-week trend: ${first} to ${last}, ${direction}`;
  return options.lastInProgress ? `${head}. This week so far: ${weeks[weeks.length - 1]}` : head;
}

/**
 * Which evidence cohort backs a department card, if any.
 *
 * The department keys and the evidence metric names are NOT the same vocabulary — the "estimating"
 * department is backed by the "estimated" cohort — so the mapping is written down rather than assumed
 * from the label. `collected` is deferred: it has no number on the card, so there is nothing to open
 * and the card must not offer to.
 */
export function departmentEvidenceMetric(
  metric: Pick<DepartmentMetric, "key" | "deferred">,
): EvidenceMetric | null {
  if (metric.deferred) return null;
  switch (metric.key) {
    case "won":
      return "won";
    case "sent":
      return "sent";
    case "estimating":
      return "estimated";
    default:
      // `collected` today, and anything the server adds tomorrow. A card whose cohort this does not
      // know is not drillable rather than drilled into the wrong one.
      return null;
  }
}
