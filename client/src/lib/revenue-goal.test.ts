import { describe, it, expect } from "vitest";
import {
  ANNUAL_REVENUE_GOAL,
  periodRevenueTarget,
  periodElapsedFraction,
  periodExpectedToDate,
  derivePace,
} from "./revenue-goal";

describe("revenue-goal", () => {
  it("uses a $33M annual goal split evenly into quarter and month targets", () => {
    expect(ANNUAL_REVENUE_GOAL).toBe(33_000_000);
    expect(periodRevenueTarget("ytd")).toBe(33_000_000);
    expect(periodRevenueTarget("qtd")).toBe(8_250_000);
    expect(periodRevenueTarget("mtd")).toBe(2_750_000);
  });

  it("prorates YTD by day-of-year over a fixed 365", () => {
    // 2026-05-30 is day-of-year 150 (Jan 31 + Feb 28 + Mar 31 + Apr 30 + 30).
    const now = new Date("2026-05-30T12:00:00Z");
    expect(periodElapsedFraction("ytd", now)).toBeCloseTo(150 / 365, 9);
    expect(periodExpectedToDate("ytd", now)).toBeCloseTo((33_000_000 * 150) / 365, 2);
  });

  it("prorates QTD by day within the quarter (Q2 = 91 days)", () => {
    // 2026-05-30 is day 60 of Q2 (Apr 30 + May 30).
    expect(periodElapsedFraction("qtd", new Date("2026-05-30T12:00:00Z"))).toBeCloseTo(60 / 91, 9);
  });

  it("prorates MTD by day within the month (May = 31 days)", () => {
    expect(periodElapsedFraction("mtd", new Date("2026-05-30T12:00:00Z"))).toBeCloseTo(30 / 31, 9);
  });

  it("reaches a full period at the last day (fraction = 1)", () => {
    expect(periodElapsedFraction("ytd", new Date("2026-12-31T12:00:00Z"))).toBeCloseTo(1, 9);
    expect(periodElapsedFraction("qtd", new Date("2026-06-30T12:00:00Z"))).toBeCloseTo(1, 9);
    expect(periodElapsedFraction("mtd", new Date("2026-05-31T12:00:00Z"))).toBeCloseTo(1, 9);
  });

  it("classifies pace by Closed vs prorated expected-to-date", () => {
    // YTD on 2026-05-30: expected ~$13.56M; Closed $9.78M -> Behind.
    const expected = periodExpectedToDate("ytd", new Date("2026-05-30T12:00:00Z"));
    expect(derivePace(9_778_045.9, expected)).toBe("Behind");
    expect(derivePace(expected, expected)).toBe("On track");
    expect(derivePace(expected * 1.25, expected)).toBe("Ahead");
  });
});
