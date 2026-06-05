import { describe, expect, it } from "vitest";
import { parseDirectorEvidenceParams } from "../../../src/modules/reports/routes.js";

// The Director Scorecard evidence endpoint's query parsing/validation (the HTTP wiring is thin; the date/
// office/owner scope reuses normalizePerformanceReportFilters, so this only locks the metric + repId contract).
describe("parseDirectorEvidenceParams", () => {
  it("requires a known metric", () => {
    expect(() => parseDirectorEvidenceParams({})).toThrow(/metric/);
    expect(() => parseDirectorEvidenceParams({ metric: "bogus" })).toThrow(/metric/);
  });

  it("accepts each supported metric and defaults scope to office (repId undefined)", () => {
    for (const metric of ["won", "lost", "pipeline", "commit", "best_case"]) {
      const p = parseDirectorEvidenceParams({ metric });
      expect(p.metric).toBe(metric);
      expect(p.repId).toBeUndefined(); // office-wide -> reconciles to the office figure
    }
  });

  it("passes a uuid repId through for a per-rep drill", () => {
    const uuid = "11111111-1111-1111-1111-111111111111";
    expect(parseDirectorEvidenceParams({ metric: "won", repId: uuid }).repId).toBe(uuid);
  });

  it("rejects a malformed repId, including the __unassigned__ sentinel (no Unassigned bucket on this report)", () => {
    expect(() => parseDirectorEvidenceParams({ metric: "won", repId: "not-a-uuid" })).toThrow(/repId/);
    expect(() => parseDirectorEvidenceParams({ metric: "won", repId: "__unassigned__" })).toThrow(/repId/);
  });
});
