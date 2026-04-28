export const ACTIVITY_RANGES = ["week", "month", "ytd"] as const;

export type ActivityRange = (typeof ACTIVITY_RANGES)[number];

export const DEFAULT_ACTIVITY_RANGE: ActivityRange = "week";

// Display strings for the dropdown. Keep colocated with the enum so the
// option list and labels can never drift.
export const ACTIVITY_RANGE_LABELS: Record<ActivityRange, string> = {
  week: "Week",
  month: "Month",
  ytd: "Year to Date",
};

export function isActivityRange(value: unknown): value is ActivityRange {
  return typeof value === "string" && (ACTIVITY_RANGES as readonly string[]).includes(value);
}
