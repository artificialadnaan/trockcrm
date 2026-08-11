// @vitest-environment jsdom
//
// The default range is computed from "today", and getting that wrong shifts every report's default by a
// day, silently. It has been wrong twice here, in opposite directions:
//
//   1. local date arithmetic serialised through toISOString()  -> a day out every evening west of UTC
//   2. anchored in America/Chicago                             -> a day out for the UTC-bucketed reports
//                                                                 (Daily Activity Log, Rep Activity) during
//                                                                 the hours UTC has rolled over and Chicago
//                                                                 has not
//
// This control is SHARED and the reports genuinely disagree about zones, so it means the least surprising
// thing: the date on the viewer's own calendar. Each report then interprets that date in its documented
// zone. The invariant worth pinning is that ONE zone is used throughout the calculation — mixing two is
// what produced both bugs.
import { afterEach, describe, expect, it, vi } from "vitest";
import { rangeDatesForTest } from "./report-filter-bar";

/** The viewer's own calendar date, computed independently of the code under test. */
function viewerToday(now: Date) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("report filter defaults", () => {
  // Instants chosen to straddle midnight in several zones at once, which is where a mixed-zone calculation
  // shows itself: 03:00 UTC is still yesterday in Chicago, and 23:00 UTC is already tomorrow in Tokyo.
  const INSTANTS = ["2026-06-15T03:00:00Z", "2026-06-15T14:00:00Z", "2026-06-15T23:00:00Z"];

  for (const instant of INSTANTS) {
    it(`ends on the viewer's own calendar date at ${instant}`, () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(instant));

      expect(rangeDatesForTest("90").dateTo).toBe(viewerToday(new Date(instant)));
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
