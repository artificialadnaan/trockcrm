import { describe, expect, it } from "vitest";
import {
  buildCompanyCamImportPlan,
  normalizeCompanyCamProjectName,
} from "../../../scripts/companycam-inventory";

describe("companycam-inventory", () => {
  it("matches projects by embedded project number before falling back to fuzzy names", () => {
    const plan = buildCompanyCamImportPlan(
      [
        { id: "cc-1", name: "DFW-2-08926-ab Roof Progress", photoCount: 12 },
        { id: "cc-2", name: "North Campus Roofing", photoCount: 5 },
        { id: "cc-3", name: "Unmatched Project", photoCount: 3 },
      ],
      [
        { id: "deal-1", name: "Different Name", dealNumber: "D-1", projectNumber: "DFW-2-08926-ab", companycamProjectId: null },
        { id: "deal-2", name: "North Campus Roofing", dealNumber: "D-2", projectNumber: null, companycamProjectId: null },
      ]
    );

    expect(plan.rows[0]).toMatchObject({ companyCamProjectId: "cc-1", matchedDealId: "deal-1", confidence: 1 });
    expect(plan.rows[1]).toMatchObject({ companyCamProjectId: "cc-2", matchedDealId: "deal-2", confidence: 1 });
    expect(plan.rows[2]).toMatchObject({ companyCamProjectId: "cc-3", matchedDealId: null, confidence: 0 });
    expect(plan.totals).toMatchObject({ matchedProjects: 2, unmatchedProjects: 1, totalPhotos: 20 });
  });

  it("normalizes punctuation and suffix words from project names", () => {
    expect(normalizeCompanyCamProjectName("North Campus - Roofing Project")).toBe("north campus roofing");
  });

  it("leaves lower-confidence fuzzy matches unmatched for manual review", () => {
    const plan = buildCompanyCamImportPlan(
      [{ id: "cc-low", name: "North Campus Exterior", photoCount: 7 }],
      [{ id: "deal-low", name: "North Campus Roof", dealNumber: "D-3", projectNumber: null, companycamProjectId: null }]
    );

    expect(plan.rows[0]).toMatchObject({
      matchedDealId: null,
      confidence: 0,
      matchReason: "unmatched",
    });
  });
});
