// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { startOfWeekToDate } from "./director-rep-detail";

// D-7: ONE platform-wide week definition = Sunday->Saturday (for the Sunday weekly-won meeting).
// The rep-detail "WTD" quick-filter must anchor to Sunday, never Monday.
describe("rep-detail startOfWeekToDate (Sunday-anchored, D-7)", () => {
  it("anchors to the most recent Sunday from a midweek reference (UTC)", () => {
    // 2026-05-27 is a Wednesday; Sunday-anchored start is 2026-05-24 (Monday-anchored would be 2026-05-25).
    expect(startOfWeekToDate(new Date(Date.UTC(2026, 4, 27)))).toBe("2026-05-24");
  });

  it("returns the same day when the reference is already a Sunday (UTC)", () => {
    // 2026-05-24 is a Sunday.
    expect(startOfWeekToDate(new Date(Date.UTC(2026, 4, 24)))).toBe("2026-05-24");
  });
});
