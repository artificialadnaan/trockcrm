import { describe, expect, it } from "vitest";
import { parseAnalyticsEvidenceParams } from "../../../src/modules/reports/routes.js";

// The Analytics evidence endpoints' query parsing/validation (date/office/owner scope reuses
// parseTier4Filters, so this only locks the metric whitelist + repId contract). Unlike the Tier-2 reports,
// Analytics LEFT-joins users (includes unassigned deals), so __unassigned__ IS a valid drill bucket here.
describe("parseAnalyticsEvidenceParams", () => {
  it("requires a metric within the report's allowed set", () => {
    expect(() => parseAnalyticsEvidenceParams({}, ["deal_count"])).toThrow(/metric/);
    expect(() => parseAnalyticsEvidenceParams({ metric: "bogus" }, ["deal_count"])).toThrow(/metric/);
    // open_value is Customer Concentration's metric — Market Mix's endpoint must reject it.
    expect(() => parseAnalyticsEvidenceParams({ metric: "open_value" }, ["deal_count"])).toThrow(/metric/);
  });

  it("accepts the report's metric and defaults scope to office (repId undefined)", () => {
    const p = parseAnalyticsEvidenceParams({ metric: "open_value" }, ["open_value"]);
    expect(p.metric).toBe("open_value");
    expect(p.repId).toBeUndefined();
  });

  it("maps __unassigned__ to the null bucket (Analytics includes unassigned deals), and a uuid to that rep", () => {
    expect(parseAnalyticsEvidenceParams({ metric: "deal_count", repId: "__unassigned__" }, ["deal_count"]).repId).toBeNull();
    const uuid = "11111111-1111-1111-1111-111111111111";
    expect(parseAnalyticsEvidenceParams({ metric: "deal_count", repId: uuid }, ["deal_count"]).repId).toBe(uuid);
  });

  it("rejects a malformed repId", () => {
    expect(() => parseAnalyticsEvidenceParams({ metric: "deal_count", repId: "nope" }, ["deal_count"])).toThrow(/repId/);
  });
});
