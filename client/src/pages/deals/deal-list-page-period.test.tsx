// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { getDashboardPeriodDateRange } from "./deal-list-page";

// D-7: ONE platform-wide week definition = Sunday->Saturday. The dashboard "week" period
// (rep-dashboard Week tab / drilldowns) must anchor to Sunday, never Monday.
describe("getDashboardPeriodDateRange week (Sunday-anchored, D-7)", () => {
  it("anchors the week period to the most recent Sunday from a midweek reference", () => {
    // 2026-05-27 is a Wednesday; Sunday-anchored start is 2026-05-24 (Monday-anchored would be 2026-05-25).
    const now = new Date(2026, 4, 27);
    expect(getDashboardPeriodDateRange("week", now)).toEqual({ from: "2026-05-24", to: "2026-05-27" });
  });

  it("returns the same day when the reference is already a Sunday", () => {
    const now = new Date(2026, 4, 24);
    expect(getDashboardPeriodDateRange("week", now)).toEqual({ from: "2026-05-24", to: "2026-05-24" });
  });
});
