import { describe, expect, it } from "vitest";
import {
  daysUntilCloseTarget,
  isAtRiskSuppressedByCloseTarget,
  isDealEffectivelyOnHold,
  CLOSE_TARGET_HOLD_HORIZON_DAYS,
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

  it("returns null for impossible calendar dates instead of silently rolling them over", () => {
    expect(daysUntilCloseTarget("2026-02-31", NOW)).toBeNull();
    expect(daysUntilCloseTarget("2026-13-01", NOW)).toBeNull();
    expect(daysUntilCloseTarget("2026-04-31", NOW)).toBeNull();
    // a genuine leap day still parses
    expect(daysUntilCloseTarget("2028-02-29", NOW)).not.toBeNull();
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

describe("isAtRiskSuppressedByCloseTarget", () => {
  it("suppresses for any today-or-future close target", () => {
    expect(isAtRiskSuppressedByCloseTarget({ expectedCloseDate: TODAY, now: NOW })).toBe(true);
    expect(isAtRiskSuppressedByCloseTarget({ expectedCloseDate: plusDays(TODAY, 1), now: NOW })).toBe(true);
    expect(isAtRiskSuppressedByCloseTarget({ expectedCloseDate: plusDays(TODAY, 45), now: NOW })).toBe(true);
    // no upper bound: a far-future target still suppresses at-risk. (It is ALSO effectively on hold past
    // the 90-day horizon — see isDealEffectivelyOnHold — but that is a separate, value/badge concern.)
    expect(isAtRiskSuppressedByCloseTarget({ expectedCloseDate: plusDays(TODAY, 200), now: NOW })).toBe(true);
  });

  it("does not suppress once the target passes (becomes at risk again)", () => {
    expect(isAtRiskSuppressedByCloseTarget({ expectedCloseDate: plusDays(TODAY, -1), now: NOW })).toBe(false);
    expect(isAtRiskSuppressedByCloseTarget({ expectedCloseDate: plusDays(TODAY, -30), now: NOW })).toBe(false);
  });

  it("does not suppress for a missing or unparseable target", () => {
    expect(isAtRiskSuppressedByCloseTarget({ expectedCloseDate: null, now: NOW })).toBe(false);
    expect(isAtRiskSuppressedByCloseTarget({ expectedCloseDate: "not-a-date", now: NOW })).toBe(false);
  });
});

describe("isDealEffectivelyOnHold", () => {
  it("is true when the deal is explicitly on hold (regardless of close date)", () => {
    expect(isDealEffectivelyOnHold({ onHold: true, expectedCloseDate: null, now: NOW })).toBe(true);
    expect(isDealEffectivelyOnHold({ onHold: true, expectedCloseDate: plusDays(TODAY, -30), now: NOW })).toBe(true);
  });

  it("is true when the close target is PAST the 90-day horizon (auto-park)", () => {
    expect(CLOSE_TARGET_HOLD_HORIZON_DAYS).toBe(90);
    expect(isDealEffectivelyOnHold({ onHold: false, expectedCloseDate: plusDays(TODAY, 91), now: NOW })).toBe(true);
    expect(isDealEffectivelyOnHold({ onHold: false, expectedCloseDate: plusDays(TODAY, 200), now: NOW })).toBe(true);
  });

  it("is FALSE exactly at the 90-day boundary (strictly greater-than, mirroring the SQL '> + INTERVAL 90 days')", () => {
    expect(isDealEffectivelyOnHold({ onHold: false, expectedCloseDate: plusDays(TODAY, 90), now: NOW })).toBe(false);
    expect(isDealEffectivelyOnHold({ onHold: false, expectedCloseDate: plusDays(TODAY, 89), now: NOW })).toBe(false);
  });

  it("is false for a near-term, past, null, or unparseable target when not explicitly held", () => {
    expect(isDealEffectivelyOnHold({ onHold: false, expectedCloseDate: plusDays(TODAY, 30), now: NOW })).toBe(false);
    expect(isDealEffectivelyOnHold({ onHold: false, expectedCloseDate: plusDays(TODAY, -10), now: NOW })).toBe(false);
    expect(isDealEffectivelyOnHold({ onHold: false, expectedCloseDate: null, now: NOW })).toBe(false);
    expect(isDealEffectivelyOnHold({ onHold: null, expectedCloseDate: "not-a-date", now: NOW })).toBe(false);
  });
});
