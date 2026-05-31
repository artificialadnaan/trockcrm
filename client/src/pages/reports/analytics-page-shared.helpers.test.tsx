import { describe, expect, it } from "vitest";
import { formatCurrency, formatNumber, formatPercent, formatDate } from "./analytics-page-shared";

/**
 * Guards for the analytics scaffold's format helpers — the BROKEN twin of the
 * safe sales-report-ui scaffold. Before this fix:
 *   - formatCurrency(NaN) -> "$NaN", formatPercent(NaN) -> "NaN%" (unguarded
 *     Intl.NumberFormat.format(value)); and
 *   - formatDate("2026-01-14") used new Date(value) (UTC midnight) -> rendered a
 *     day early west of UTC (the #572 date-only off-by-one).
 */

describe("analytics-page-shared format helpers — NaN/empty guards", () => {
  it("formatCurrency never emits $NaN for NaN / null / undefined / Infinity", () => {
    expect(formatCurrency(Number.NaN)).toBe("$0");
    expect(formatCurrency(null)).toBe("$0");
    expect(formatCurrency(undefined)).toBe("$0");
    expect(formatCurrency(Number.POSITIVE_INFINITY)).toBe("$0");
    // a real value still formats normally
    expect(formatCurrency(250000)).toBe("$250,000");
  });

  it("formatPercent never emits NaN% for NaN / null / undefined", () => {
    expect(formatPercent(Number.NaN)).toBe("0.0%");
    expect(formatPercent(null)).toBe("0.0%");
    expect(formatPercent(undefined)).toBe("0.0%");
    expect(formatPercent(66.7)).toBe("66.7%");
  });

  it("formatNumber never emits NaN for NaN / null / undefined", () => {
    expect(formatNumber(Number.NaN)).toBe("0");
    expect(formatNumber(null)).toBe("0");
    expect(formatNumber(1234)).toBe("1,234");
  });
});

describe("analytics-page-shared formatDate — date-only is calendar-anchored (#572)", () => {
  it("renders a date-only string on its literal calendar day (no UTC off-by-one)", () => {
    // parseDisplayDate anchors "YYYY-MM-DD" to local midnight, so the day stays Jan 14
    // regardless of the runner's timezone. `new Date("2026-01-14")` would parse as UTC
    // midnight and render "Jan 13" anywhere west of UTC.
    expect(formatDate("2026-01-14")).toBe("Jan 14, 2026");
  });

  it("returns the no-activity sentinel for null", () => {
    expect(formatDate(null)).toBe("No activity");
  });
});
