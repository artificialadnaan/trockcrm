// @vitest-environment jsdom
//
// The default range is computed from "today", and every report these filters drive windows in business
// time (server/src/lib/period.ts). Getting that anchor wrong shifts every default by a day, silently, for
// a subset of viewers — which happened twice in a row here:
//
//   1. local date arithmetic serialised through toISOString()  -> wrong after 6pm for Central viewers
//   2. a Chicago date string reparsed as local midnight        -> wrong ALL DAY for anyone ahead of Chicago
//
// Both passed a casual check because they were correct in the author's own timezone. These cases pin the
// invariant that actually matters: whatever the viewer's zone, the default bounds are the BUSINESS
// calendar's dates, and the span between them is exactly the requested number of days.
import { afterEach, describe, expect, it, vi } from "vitest";
import { rangeDatesForTest } from "./report-filter-bar";

const BUSINESS_TIMEZONE = "America/Chicago";

/** What the business calendar says "today" is, computed independently of the code under test. */
function chicagoToday(now: Date) {
  return now.toLocaleDateString("en-CA", { timeZone: BUSINESS_TIMEZONE });
}

function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("report filter defaults are anchored in business time", () => {
  // 03:00 UTC is the previous day in Chicago but already "today" in UTC/Tokyo — the instant that exposes
  // an anchor which crosses a zone boundary more than once.
  const INSTANTS = ["2026-06-15T03:00:00Z", "2026-06-15T14:00:00Z", "2026-06-16T04:59:00Z"];

  for (const instant of INSTANTS) {
    it(`ends the range on the business date, not the viewer's, at ${instant}`, () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(instant));

      expect(rangeDatesForTest("90").dateTo).toBe(chicagoToday(new Date(instant)));
    });
  }

  it("spans exactly the requested number of days", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T14:00:00Z"));

    for (const range of ["30", "60", "90"]) {
      const { dateFrom, dateTo } = rangeDatesForTest(range);
      expect(daysBetween(dateFrom, dateTo), `range=${range}`).toBe(Number(range));
    }
  });

  it("emits plain YYYY-MM-DD, which is what the endpoints parse", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T14:00:00Z"));

    const { dateFrom, dateTo } = rangeDatesForTest("90");
    expect(dateFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(dateTo).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(dateFrom < dateTo).toBe(true);
  });
});
