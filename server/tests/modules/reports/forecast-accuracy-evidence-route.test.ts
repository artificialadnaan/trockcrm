import { describe, expect, it } from "vitest";
import { parseForecastEvidenceParams } from "../../../src/modules/reports/routes.js";

// The Forecast Accuracy evidence endpoint's query parsing/validation (the HTTP wiring is thin; date/office/
// owner scope reuses normalizePerformanceReportFilters, so this only locks the metric + repId contract).
describe("parseForecastEvidenceParams", () => {
  it("requires a known metric", () => {
    expect(() => parseForecastEvidenceParams({})).toThrow(/metric/);
    expect(() => parseForecastEvidenceParams({ metric: "bogus" })).toThrow(/metric/);
  });

  it("accepts each supported metric and defaults scope to office (repId undefined)", () => {
    for (const metric of ["commit", "best_case", "pipeline_weighted", "won_actual"]) {
      const p = parseForecastEvidenceParams({ metric });
      expect(p.metric).toBe(metric);
      expect(p.repId).toBeUndefined(); // office-wide -> reconciles to the office figure
    }
  });

  it("passes a uuid repId through for a per-rep drill", () => {
    const uuid = "11111111-1111-1111-1111-111111111111";
    expect(parseForecastEvidenceParams({ metric: "commit", repId: uuid }).repId).toBe(uuid);
  });

  it("rejects a malformed repId, including the __unassigned__ sentinel (no Unassigned bucket on this report)", () => {
    expect(() => parseForecastEvidenceParams({ metric: "commit", repId: "not-a-uuid" })).toThrow(/repId/);
    expect(() => parseForecastEvidenceParams({ metric: "commit", repId: "__unassigned__" })).toThrow(/repId/);
  });
});
