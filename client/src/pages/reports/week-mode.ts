// Single source for the WTD / last-full-week toggle's default, shared by every report that has the toggle
// (Monday Showcase, Rep 1:1 Pack, Forecast Confidence Board) so it can't drift per-view.
//
// Default = "completed" (Last full week), NOT week-to-date. These reports get opened in Monday meetings; on
// a Monday morning the week-to-date window captures almost nothing (an empty/near-empty week), so the
// valuable, complete metric a team reviews is LAST full week. The user can still switch to WTD.
export type WeekMode = "to_date" | "completed";
export const DEFAULT_WEEK_MODE: WeekMode = "completed";
