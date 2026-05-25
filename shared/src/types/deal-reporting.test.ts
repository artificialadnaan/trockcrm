import { describe, expect, it } from "vitest";
import {
  isDealActivelyOnHold,
  isReportableDeal,
  reportableDealSqlPredicate,
} from "./deal-reporting.js";

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
});
