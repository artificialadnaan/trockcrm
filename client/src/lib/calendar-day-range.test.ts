import { describe, expect, it } from "vitest";
import { endOfCalendarDayIso, startOfCalendarDayIso } from "./calendar-day-range";

/**
 * These assertions are written to be timezone-INDEPENDENT: the suite runs wherever the developer or CI
 * happens to be, so they check the invariants (same local calendar day, full span, correct ordering)
 * rather than hard-coded instants that would only hold in one offset.
 */
describe("calendar day range", () => {
  const localDay = (iso: string) => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  it("puts both bounds on the calendar day the user picked, in their own timezone", () => {
    const start = startOfCalendarDayIso("2026-07-27")!;
    const end = endOfCalendarDayIso("2026-07-27")!;

    expect(localDay(start)).toBe("2026-07-27");
    expect(localDay(end)).toBe("2026-07-27");
    expect(new Date(start).getHours()).toBe(0);
    expect(new Date(end).getHours()).toBe(23);
  });

  /**
   * The regression. `new Date("2026-07-27")` parses as UTC midnight and `setHours` then mutates in LOCAL
   * time, so in any timezone behind UTC the two disagree and the "day" collapses to a few hours ending
   * the previous local evening. A same-day selection must span a full day, not a sliver.
   */
  it("spans a whole day for a same-day selection — the UTC/local mix collapsed this to a few hours", () => {
    const start = startOfCalendarDayIso("2026-07-27")!;
    const end = endOfCalendarDayIso("2026-07-27")!;
    const spanMs = new Date(end).getTime() - new Date(start).getTime();

    // Exactly one day minus the final millisecond. (DST transitions would make this 23h or 25h; the
    // assertion allows that without letting the old five-hour window through.)
    expect(spanMs).toBeGreaterThanOrEqual(22 * 60 * 60 * 1000);
    expect(spanMs).toBeLessThanOrEqual(26 * 60 * 60 * 1000);

    // The old implementation, reproduced, to show what it actually produced here.
    const legacyEnd = new Date("2026-07-27");
    legacyEnd.setHours(23, 59, 59, 999);
    const legacySpan = legacyEnd.getTime() - new Date(start).getTime();
    if (new Date("2026-07-27T00:00:00Z").getTimezoneOffset() > 0) {
      // Only meaningful in a timezone behind UTC, which is where this product runs (US Central).
      expect(legacySpan).toBeLessThan(spanMs);
    }
  });

  it("orders a multi-day range correctly", () => {
    const start = startOfCalendarDayIso("2026-07-01")!;
    const end = endOfCalendarDayIso("2026-07-31")!;
    expect(new Date(start).getTime()).toBeLessThan(new Date(end).getTime());
    expect(localDay(start)).toBe("2026-07-01");
    expect(localDay(end)).toBe("2026-07-31");
  });

  it("returns undefined for anything that is not a plain YYYY-MM-DD", () => {
    for (const bad of ["", "   ", "2026", "2026-07", "garbage", "2026-07-27T10:00:00Z"]) {
      expect(startOfCalendarDayIso(bad)).toBeUndefined();
      expect(endOfCalendarDayIso(bad)).toBeUndefined();
    }
  });
});
