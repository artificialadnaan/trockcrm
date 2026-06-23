import { describe, expect, it } from "vitest";
import {
  isDealActivelyOnHold,
  isReportableDeal,
  reportableDealSqlPredicate,
  effectiveOnHoldSqlPredicate,
} from "./deal-reporting.js";
import { CLOSE_TARGET_HOLD_HORIZON_DAYS } from "./deal-hold-risk.js";

describe("deal reporting helpers", () => {
  it("uses active on-hold state as the single reportability rule", () => {
    expect(isDealActivelyOnHold({ onHold: true })).toBe(true);
    expect(isReportableDeal({ onHold: true })).toBe(false);
    expect(isReportableDeal({ onHold: false })).toBe(true);
    expect(isReportableDeal({ onHold: null })).toBe(true);
  });

  it("builds the shared SQL predicate from the same on_hold field", () => {
    expect(reportableDealSqlPredicate()).toBe("COALESCE(on_hold, false) = false");
    expect(reportableDealSqlPredicate("d")).toBe("COALESCE(d.on_hold, false) = false");
    expect(reportableDealSqlPredicate("open_deals")).toBe(
      "COALESCE(open_deals.on_hold, false) = false"
    );
    expect(() => reportableDealSqlPredicate("d; DROP TABLE deals")).toThrow();
  });

  it("builds the effective-on-hold predicate: stored on_hold OR a close target past the 90-day horizon", () => {
    // The horizon constant is shared with the TS twin so SQL + TS can never drift.
    expect(CLOSE_TARGET_HOLD_HORIZON_DAYS).toBe(90);

    expect(effectiveOnHoldSqlPredicate()).toBe(
      "(COALESCE(on_hold, false) = true OR (expected_close_date IS NOT NULL AND " +
        "expected_close_date > (now() AT TIME ZONE 'America/Chicago')::date + INTERVAL '90 days'))"
    );
    expect(effectiveOnHoldSqlPredicate("d")).toBe(
      "(COALESCE(d.on_hold, false) = true OR (d.expected_close_date IS NOT NULL AND " +
        "d.expected_close_date > (now() AT TIME ZONE 'America/Chicago')::date + INTERVAL '90 days'))"
    );
    // CT anchor matches reportableDealSqlPredicate's day boundary (America/Chicago), so the pill and
    // the forecast SQL agree to the day.
    expect(effectiveOnHoldSqlPredicate("open_deals")).toContain(
      "(now() AT TIME ZONE 'America/Chicago')::date + INTERVAL '90 days'"
    );
    expect(() => effectiveOnHoldSqlPredicate("d; DROP TABLE deals")).toThrow();
  });
});
