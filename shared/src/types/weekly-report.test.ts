import { describe, expect, it } from "vitest";
import {
  WEEKLY_REPORT_PHOTO_WINDOW_DAYS,
  canTransitionWeeklyReport,
  daysBetweenIsoDates,
  isIsoDateString,
  isoDateWeekday,
  shiftIsoDate,
  weeklyReportDaysLate,
  weeklyReportExpectedWeeks,
  weeklyReportNextStatuses,
  weeklyReportPhotoWindow,
  weeklyReportRemainingWeeks,
  weeklyReportWeekOf,
} from "./weekly-report.js";

// The reference report: "Week of 8/13/26", a THURSDAY, for a Thursday-cadence project.
const THURSDAY = 4;
const WEEK_OF = "2026-08-13";

describe("iso date primitives", () => {
  it("rejects shaped-but-impossible dates rather than rolling them over", () => {
    expect(isIsoDateString("2026-02-30")).toBe(false);
    expect(isIsoDateString("2026-13-01")).toBe(false);
    expect(isIsoDateString("2026-02-28")).toBe(true);
    // A leap year the 100/400 rule gets wrong if hand-rolled.
    expect(isIsoDateString("2000-02-29")).toBe(true);
    expect(isIsoDateString("1900-02-29")).toBe(false);
  });

  it("rejects non-date input", () => {
    expect(isIsoDateString("")).toBe(false);
    expect(isIsoDateString("2026-8-13")).toBe(false);
    expect(isIsoDateString(20260813)).toBe(false);
    expect(isIsoDateString(null)).toBe(false);
  });

  it("throws rather than silently producing a wrong date", () => {
    expect(() => shiftIsoDate("2026-02-30", 1)).toThrow(RangeError);
    expect(() => isoDateWeekday("nope")).toThrow(RangeError);
  });

  it("agrees with Postgres EXTRACT(DOW): 0 = Sunday", () => {
    expect(isoDateWeekday("2026-08-09")).toBe(0); // Sunday
    expect(isoDateWeekday(WEEK_OF)).toBe(THURSDAY);
    expect(isoDateWeekday("2026-08-15")).toBe(6); // Saturday
  });

  // The reason every function here parses at UTC noon. US DST ends 2026-11-01; a midnight-anchored
  // shift lands on the wrong calendar day across that boundary for negative-offset timezones.
  it("crosses a DST boundary without losing a day", () => {
    expect(shiftIsoDate("2026-10-31", 1)).toBe("2026-11-01");
    expect(shiftIsoDate("2026-11-01", 1)).toBe("2026-11-02");
    expect(shiftIsoDate("2026-11-02", -2)).toBe("2026-10-31");
    // And the spring-forward boundary.
    expect(shiftIsoDate("2026-03-07", 1)).toBe("2026-03-08");
    expect(shiftIsoDate("2026-03-08", 1)).toBe("2026-03-09");
    expect(daysBetweenIsoDates("2026-03-07", "2026-03-09")).toBe(2);
    expect(daysBetweenIsoDates("2026-10-31", "2026-11-02")).toBe(2);
  });

  it("counts days signed, across month and year ends", () => {
    expect(daysBetweenIsoDates("2026-08-13", "2026-08-20")).toBe(7);
    expect(daysBetweenIsoDates("2026-08-20", "2026-08-13")).toBe(-7);
    expect(daysBetweenIsoDates("2026-12-31", "2027-01-01")).toBe(1);
    expect(daysBetweenIsoDates("2028-02-28", "2028-03-01")).toBe(2); // leap year
  });
});

describe("weeklyReportWeekOf", () => {
  it("returns the due date itself when asked on the due date", () => {
    expect(weeklyReportWeekOf(THURSDAY, WEEK_OF)).toBe(WEEK_OF);
  });

  it("returns the upcoming due date when asked earlier in the cadence week", () => {
    expect(weeklyReportWeekOf(THURSDAY, "2026-08-10")).toBe(WEEK_OF); // Monday
    expect(weeklyReportWeekOf(THURSDAY, "2026-08-12")).toBe(WEEK_OF); // Wednesday
  });

  // The day AFTER the due date belongs to the NEXT week. This is what keeps a missed week visible as an
  // outstanding row instead of being silently absorbed into the following one.
  it("rolls to the next week the day after the due date", () => {
    expect(weeklyReportWeekOf(THURSDAY, "2026-08-14")).toBe("2026-08-20"); // Friday
    expect(weeklyReportWeekOf(THURSDAY, "2026-08-19")).toBe("2026-08-20"); // Wednesday
  });

  it("handles a Sunday cadence, where the weekday index wraps", () => {
    expect(weeklyReportWeekOf(0, "2026-08-10")).toBe("2026-08-16"); // Mon -> next Sun
    expect(weeklyReportWeekOf(0, "2026-08-16")).toBe("2026-08-16"); // Sun -> itself
  });

  it("rejects an out-of-range weekday instead of computing nonsense", () => {
    expect(() => weeklyReportWeekOf(7, WEEK_OF)).toThrow(RangeError);
    expect(() => weeklyReportWeekOf(-1, WEEK_OF)).toThrow(RangeError);
    expect(() => weeklyReportWeekOf(1.5, WEEK_OF)).toThrow(RangeError);
  });
});

describe("weeklyReportExpectedWeeks", () => {
  it("generates every due date from the cadence start through the given date", () => {
    expect(
      weeklyReportExpectedWeeks({
        cadenceWeekday: THURSDAY,
        cadenceStartDate: "2026-07-27", // a Monday
        throughDate: "2026-08-18",
      }),
    ).toEqual(["2026-07-30", "2026-08-06", WEEK_OF]);
  });

  it("includes a due date that falls exactly on the through date", () => {
    expect(
      weeklyReportExpectedWeeks({
        cadenceWeekday: THURSDAY,
        cadenceStartDate: "2026-08-01",
        throughDate: WEEK_OF,
      }),
    ).toEqual(["2026-08-06", WEEK_OF]);
  });

  it("clamps to cadenceEndDate when the project has stopped reporting", () => {
    expect(
      weeklyReportExpectedWeeks({
        cadenceWeekday: THURSDAY,
        cadenceStartDate: "2026-07-27",
        cadenceEndDate: "2026-08-07",
        throughDate: "2026-09-30",
      }),
    ).toEqual(["2026-07-30", "2026-08-06"]);
  });

  it("returns nothing for a cadence that has not started yet", () => {
    expect(
      weeklyReportExpectedWeeks({
        cadenceWeekday: THURSDAY,
        cadenceStartDate: "2026-09-01",
        throughDate: "2026-08-18",
      }),
    ).toEqual([]);
  });

  it("returns nothing when the end date precedes the start date", () => {
    expect(
      weeklyReportExpectedWeeks({
        cadenceWeekday: THURSDAY,
        cadenceStartDate: "2026-08-01",
        cadenceEndDate: "2026-07-01",
        throughDate: "2026-12-31",
      }),
    ).toEqual([]);
  });

  it("stays weekly across a DST boundary", () => {
    const weeks = weeklyReportExpectedWeeks({
      cadenceWeekday: THURSDAY,
      cadenceStartDate: "2026-10-26",
      throughDate: "2026-11-13",
    });
    expect(weeks).toEqual(["2026-10-29", "2026-11-05", "2026-11-12"]);
    for (let i = 1; i < weeks.length; i += 1) {
      expect(daysBetweenIsoDates(weeks[i - 1]!, weeks[i]!)).toBe(7);
    }
  });
});

describe("weeklyReportPhotoWindow", () => {
  it("spans 14 inclusive days ending on week_of", () => {
    const window = weeklyReportPhotoWindow(WEEK_OF);
    expect(window).toEqual({ from: "2026-07-31", to: WEEK_OF });
    expect(daysBetweenIsoDates(window.from, window.to) + 1).toBe(WEEKLY_REPORT_PHOTO_WINDOW_DAYS);
  });

  // Anchored on week_of, NOT on today — a late filer must still see the week they are reporting on.
  it("does not move when the report is filed late", () => {
    expect(weeklyReportPhotoWindow(WEEK_OF)).toEqual(weeklyReportPhotoWindow(WEEK_OF));
    expect(weeklyReportPhotoWindow("2026-08-20").from).toBe("2026-08-07");
  });
});

describe("weeklyReportRemainingWeeks", () => {
  it("subtracts whole elapsed weeks from the projected duration", () => {
    expect(
      weeklyReportRemainingWeeks({
        projectedDurationWeeks: 19,
        projectStartDate: "2026-07-09",
        weekOf: WEEK_OF, // 35 days later -> 5 whole weeks
      }),
    ).toBe(14);
  });

  it("returns the full duration for a project that has not started", () => {
    // The reference PDF prints Remaining 0 against Projected 19 for a "TBD Permit" start — a blank cell
    // in the source spreadsheet. Reporting 0 weeks left on a job that has not broken ground would be
    // wrong on the number a client reads first.
    expect(
      weeklyReportRemainingWeeks({
        projectedDurationWeeks: 19,
        projectStartDate: null,
        weekOf: WEEK_OF,
      }),
    ).toBe(19);
  });

  it("does not inflate past the projected duration when week_of precedes the start", () => {
    expect(
      weeklyReportRemainingWeeks({
        projectedDurationWeeks: 19,
        projectStartDate: "2026-09-01",
        weekOf: WEEK_OF,
      }),
    ).toBe(19);
  });

  it("floors at zero on an overrunning project", () => {
    expect(
      weeklyReportRemainingWeeks({
        projectedDurationWeeks: 2,
        projectStartDate: "2026-01-01",
        weekOf: WEEK_OF,
      }),
    ).toBe(0);
  });

  it("returns null when there is no projected duration", () => {
    expect(
      weeklyReportRemainingWeeks({
        projectedDurationWeeks: null,
        projectStartDate: "2026-07-09",
        weekOf: WEEK_OF,
      }),
    ).toBeNull();
  });

  it("counts partial weeks as not yet elapsed", () => {
    // 6 days in is still week 0.
    expect(
      weeklyReportRemainingWeeks({
        projectedDurationWeeks: 10,
        projectStartDate: "2026-08-07",
        weekOf: WEEK_OF,
      }),
    ).toBe(10);
    // 7 days in is exactly one week.
    expect(
      weeklyReportRemainingWeeks({
        projectedDurationWeeks: 10,
        projectStartDate: "2026-08-06",
        weekOf: WEEK_OF,
      }),
    ).toBe(9);
  });
});

describe("status ladder", () => {
  it("permits only the designed transitions", () => {
    expect(canTransitionWeeklyReport("draft", "pending_review")).toBe(true);
    expect(canTransitionWeeklyReport("pending_review", "approved")).toBe(true);
    expect(canTransitionWeeklyReport("pending_review", "draft")).toBe(true);
    expect(canTransitionWeeklyReport("approved", "sent")).toBe(true);
    expect(canTransitionWeeklyReport("approved", "pending_review")).toBe(true);
  });

  // The PM gate is the entire reason this feature has a review step.
  it("never lets a report reach the client without passing PM approval", () => {
    expect(canTransitionWeeklyReport("draft", "sent")).toBe(false);
    expect(canTransitionWeeklyReport("draft", "approved")).toBe(false);
    expect(canTransitionWeeklyReport("pending_review", "sent")).toBe(false);
  });

  it("treats sent as terminal, so a delivered report is never mutated", () => {
    expect(weeklyReportNextStatuses("sent")).toEqual([]);
    expect(canTransitionWeeklyReport("sent", "draft")).toBe(false);
    expect(canTransitionWeeklyReport("sent", "approved")).toBe(false);
    expect(canTransitionWeeklyReport("sent", "sent")).toBe(false);
  });

  it("rejects self-transitions", () => {
    expect(canTransitionWeeklyReport("draft", "draft")).toBe(false);
    expect(canTransitionWeeklyReport("approved", "approved")).toBe(false);
  });
});

describe("weeklyReportDaysLate", () => {
  it("is zero before and on the due date", () => {
    expect(weeklyReportDaysLate(WEEK_OF, "2026-08-10")).toBe(0);
    expect(weeklyReportDaysLate(WEEK_OF, WEEK_OF)).toBe(0);
  });

  it("counts days past the due date", () => {
    expect(weeklyReportDaysLate(WEEK_OF, "2026-08-14")).toBe(1);
    expect(weeklyReportDaysLate(WEEK_OF, "2026-09-03")).toBe(21);
  });
});
