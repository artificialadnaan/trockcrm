import { describe, expect, it } from "vitest";
import { businessWeekDates } from "../../src/lib/period.js";
describe("businessWeekDates (Sunday-Saturday)", () => {
  it("returns Sun..Sat of the week containing a Wednesday", () => {
    // 2026-06-10 is a Wednesday; the canonical week is Sun 06-07 .. Sat 06-13
    expect(businessWeekDates("2026-06-10")).toEqual([
      "2026-06-07","2026-06-08","2026-06-09","2026-06-10","2026-06-11","2026-06-12","2026-06-13",
    ]);
  });
  it("a Sunday anchors its own week", () => {
    expect(businessWeekDates("2026-06-07")[0]).toBe("2026-06-07");
  });
});
