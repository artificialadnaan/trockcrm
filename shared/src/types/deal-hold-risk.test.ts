import { describe, expect, it } from "vitest";
import {
  AUTO_ON_HOLD_TARGET_DAYS,
  daysUntilCloseTarget,
  isAtRiskSuppressedByCloseTarget,
  isAutoOnHoldByCloseTarget,
  isDealEffectivelyOnHold,
} from "./deal-hold-risk.js";

// CT (America/Chicago) is UTC-5 in June (CDT). 12:00Z = 07:00 CDT on the same calendar day.
const TODAY = "2026-06-01";
const NOW = new Date("2026-06-01T12:00:00.000Z");

function plusDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe("daysUntilCloseTarget", () => {
  it("returns null for a missing or unparseable target", () => {
    expect(daysUntilCloseTarget(null, NOW)).toBeNull();
    expect(daysUntilCloseTarget(undefined, NOW)).toBeNull();
    expect(daysUntilCloseTarget("", NOW)).toBeNull();
    expect(daysUntilCloseTarget("not-a-date", NOW)).toBeNull();
  });

  it("counts whole calendar days from CT-today to the target date", () => {
    expect(daysUntilCloseTarget(TODAY, NOW)).toBe(0);
    expect(daysUntilCloseTarget(plusDays(TODAY, 14), NOW)).toBe(14);
    expect(daysUntilCloseTarget(plusDays(TODAY, -7), NOW)).toBe(-7);
  });

  it("accepts a Date target by its UTC calendar day", () => {
    expect(daysUntilCloseTarget(new Date("2026-06-15T00:00:00.000Z"), NOW)).toBe(14);
  });

  it("anchors 'today' to the America/Chicago calendar day, not UTC", () => {
    // 04:30Z on 2026-06-01 is 23:30 the PREVIOUS day in CDT (2026-05-31).
    const lateNightCt = new Date("2026-06-01T04:30:00.000Z");
    expect(daysUntilCloseTarget("2026-05-31", lateNightCt)).toBe(0);
    expect(daysUntilCloseTarget("2026-06-01", lateNightCt)).toBe(1);
  });
});

describe("isAutoOnHoldByCloseTarget", () => {
  it("is true only when the target is strictly MORE than 90 days out", () => {
    expect(AUTO_ON_HOLD_TARGET_DAYS).toBe(90);
    expect(isAutoOnHoldByCloseTarget({ expectedCloseDate: plusDays(TODAY, 90), now: NOW })).toBe(false);
    expect(isAutoOnHoldByCloseTarget({ expectedCloseDate: plusDays(TODAY, 91), now: NOW })).toBe(true);
    expect(isAutoOnHoldByCloseTarget({ expectedCloseDate: plusDays(TODAY, 200), now: NOW })).toBe(true);
  });

  it("is false for today, past, or missing targets", () => {
    expect(isAutoOnHoldByCloseTarget({ expectedCloseDate: TODAY, now: NOW })).toBe(false);
    expect(isAutoOnHoldByCloseTarget({ expectedCloseDate: plusDays(TODAY, -10), now: NOW })).toBe(false);
    expect(isAutoOnHoldByCloseTarget({ expectedCloseDate: null, now: NOW })).toBe(false);
  });
});

describe("isAtRiskSuppressedByCloseTarget", () => {
  it("suppresses while the target is today-or-future within the 90-day window", () => {
    expect(isAtRiskSuppressedByCloseTarget({ expectedCloseDate: TODAY, now: NOW })).toBe(true);
    expect(isAtRiskSuppressedByCloseTarget({ expectedCloseDate: plusDays(TODAY, 45), now: NOW })).toBe(true);
    expect(isAtRiskSuppressedByCloseTarget({ expectedCloseDate: plusDays(TODAY, 90), now: NOW })).toBe(true);
  });

  it("does not suppress once the target passes (becomes at risk again)", () => {
    expect(isAtRiskSuppressedByCloseTarget({ expectedCloseDate: plusDays(TODAY, -1), now: NOW })).toBe(false);
    expect(isAtRiskSuppressedByCloseTarget({ expectedCloseDate: null, now: NOW })).toBe(false);
  });

  it("does not suppress beyond 90 days (that range is auto-on-hold instead)", () => {
    expect(isAtRiskSuppressedByCloseTarget({ expectedCloseDate: plusDays(TODAY, 91), now: NOW })).toBe(false);
  });
});

describe("isDealEffectivelyOnHold", () => {
  it("is true whenever the stored on_hold toggle is set, regardless of the close target", () => {
    expect(isDealEffectivelyOnHold({ onHold: true, expectedCloseDate: null }, NOW)).toBe(true);
    expect(isDealEffectivelyOnHold({ onHold: true, expectedCloseDate: plusDays(TODAY, 10) }, NOW)).toBe(true);
  });

  it("derives on-hold from a >90-day close target even when not manually held", () => {
    expect(isDealEffectivelyOnHold({ onHold: false, expectedCloseDate: plusDays(TODAY, 120) }, NOW)).toBe(true);
  });

  it("is false for an active deal with a near or absent close target", () => {
    expect(isDealEffectivelyOnHold({ onHold: false, expectedCloseDate: plusDays(TODAY, 30) }, NOW)).toBe(false);
    expect(isDealEffectivelyOnHold({ onHold: false, expectedCloseDate: null }, NOW)).toBe(false);
    expect(isDealEffectivelyOnHold({ onHold: false, expectedCloseDate: plusDays(TODAY, -5) }, NOW)).toBe(false);
  });
});
