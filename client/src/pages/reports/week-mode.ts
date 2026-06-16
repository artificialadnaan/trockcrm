// Single source for the WTD / last-full-week toggle's default, shared by every report that has the toggle
// (Monday Showcase, Rep 1:1 Pack, Forecast Confidence Board) so it can't drift per-view.
//
// Default = "completed" (Last full week), NOT week-to-date. These reports get opened in Monday meetings; on
// a Monday morning the week-to-date window captures almost nothing (an empty/near-empty week), so the
// valuable, complete metric a team reviews is LAST full week. The user can still switch to WTD.
// "mtd" / "ytd" are the Monday-Showcase month-to-date / year-to-date pinch-date options (Item 3). The
// server resolves them via getWtdPeriod (byte-identical to the Deals Dashboard resolveDatePreset), so the
// B2 Leaderboard Won numbers reconcile to /deals for the same preset. Only the Monday Showcase exposes
// mtd/ytd buttons; the other toggle pages (Rep 1:1 Pack, Forecast Confidence) keep just WTD / last week.
export type WeekMode = "to_date" | "completed" | "mtd" | "ytd";
export const DEFAULT_WEEK_MODE: WeekMode = "completed";

// Human label for a period mode (shared so every toggle renders the same wording).
export const WEEK_MODE_LABELS: Record<WeekMode, string> = {
  to_date: "Week-to-date",
  completed: "Last full week",
  mtd: "Month-to-date",
  ytd: "Year-to-date",
};

// In-sentence period word for headings / drill+evidence titles (e.g. "Won — Month to date"). Distinct
// from WEEK_MODE_LABELS (the toggle BUTTON wording). to_date/completed keep the existing relative phrasing;
// mtd/ytd get explicit windows so a month/year view never renders its numbers under a "last week" heading.
const PERIOD_WORD: Record<WeekMode, string> = {
  to_date: "this week",
  completed: "last week",
  mtd: "Month to date",
  ytd: "Year to date",
};
export const periodWord = (mode: WeekMode): string => PERIOD_WORD[mode];

// Whether to show the week-over-week DeltaChip for a given mode. The WoW baseline (the 7 days before the
// period start) is only meaningful for the weekly windows. For mtd/ytd it would compare the whole month
// against the last week of the prior month (or Jan1–today against Dec25–31) — an inflated, non-WoW arrow —
// so we HIDE the chip rather than show a misleading delta. Shared so any surface rendering these chips
// (incl. the showcase-consolidation Hybrid) gates on the SAME rule.
export const shouldShowWowDelta = (mode: WeekMode): boolean => mode === "to_date" || mode === "completed";
