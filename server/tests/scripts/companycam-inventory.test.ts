import { describe, expect, it } from "vitest";
import {
  buildCompanyCamImportPlan,
  companyCamPlanDisposition,
  normalizeCompanyCamProjectName,
  summarizeCompanyCamPlan,
} from "../../../scripts/companycam-inventory";

const PLAN_DEALS = [
  { id: "deal-link", name: "Linkville Tower Deal", dealNumber: "D-1", projectNumber: null, companycamProjectId: "cc-link", onHold: false },
  { id: "deal-num", name: "Some Deal", dealNumber: "D-2", projectNumber: "DFW-2-08926-ab", companycamProjectId: null, onHold: false },
  { id: "deal-num-onhold", name: "Other Deal", dealNumber: "D-3", projectNumber: "DFW-3-00001-zz", companycamProjectId: null, onHold: true },
  { id: "deal-fuzzy", name: "North Campus Roofing", dealNumber: "D-4", projectNumber: null, companycamProjectId: null, onHold: false },
];
const PLAN_PROJECTS = [
  { id: "cc-link", name: "Linkville Tower", photoCount: 10 }, // existing link, not on hold -> auto
  { id: "cc-num", name: "DFW-2-08926-ab Roof", photoCount: 20 }, // number-in-name, not on hold -> auto
  { id: "cc-num-onhold", name: "DFW-3-00001-zz Siding", photoCount: 30 }, // number-in-name, on hold -> manual
  { id: "cc-fuzzy", name: "North Campus Roofing", photoCount: 40 }, // fuzzy -> manual
  { id: "cc-unmatched", name: "Zzz Unmatchable Xyz", photoCount: 50 }, // unmatched -> manual
];

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

  it("flags matched-deal on-hold and only auto-seeds reliable tiers that are not on hold", () => {
    const plan = buildCompanyCamImportPlan(PLAN_PROJECTS, PLAN_DEALS);
    const byId = new Map(plan.rows.map((row) => [row.companyCamProjectId, row]));

    expect(byId.get("cc-link")).toMatchObject({ matchReason: "existing_companycam_link", matchedDealOnHold: false });
    expect(byId.get("cc-num")).toMatchObject({ matchReason: "project_number_in_name", matchedDealOnHold: false });
    expect(byId.get("cc-num-onhold")).toMatchObject({ matchReason: "project_number_in_name", matchedDealOnHold: true });
    expect(byId.get("cc-fuzzy")).toMatchObject({ matchReason: "fuzzy_project_name", matchedDealOnHold: false });
    expect(byId.get("cc-unmatched")).toMatchObject({ matchReason: "unmatched", matchedDealOnHold: null });

    expect(companyCamPlanDisposition(byId.get("cc-link")!)).toBe("auto");
    expect(companyCamPlanDisposition(byId.get("cc-num")!)).toBe("auto");
    expect(companyCamPlanDisposition(byId.get("cc-num-onhold")!)).toBe("manual_review"); // reliable tier but on hold
    expect(companyCamPlanDisposition(byId.get("cc-fuzzy")!)).toBe("manual_review"); // fuzzy is never auto (Bid Board lesson)
    expect(companyCamPlanDisposition(byId.get("cc-unmatched")!)).toBe("manual_review");
  });

  it("summarizes auto-seed vs manual-review and on-hold-excluded photo counts", () => {
    const plan = buildCompanyCamImportPlan(PLAN_PROJECTS, PLAN_DEALS);
    const summary = summarizeCompanyCamPlan(plan.rows);

    expect(summary).toMatchObject({ totalProjects: 5, totalPhotos: 150, matchedProjects: 4, unmatchedProjects: 1 });
    expect(summary.byTier.existing_companycam_link).toEqual({ projects: 1, photos: 10 });
    expect(summary.byTier.project_number_in_name).toEqual({ projects: 2, photos: 50 }); // cc-num + cc-num-onhold
    expect(summary.byTier.fuzzy_project_name).toEqual({ projects: 1, photos: 40 });
    expect(summary.byTier.unmatched).toEqual({ projects: 1, photos: 50 });
    expect(summary.onHoldExcluded).toEqual({ projects: 1, photos: 30 }); // cc-num-onhold
    expect(summary.autoSeed).toEqual({ projects: 2, photos: 30 }); // cc-link + cc-num
    expect(summary.manualReview).toEqual({ projects: 3, photos: 120 }); // on-hold + fuzzy + unmatched
    expect(plan.totals).toEqual(summary); // buildCompanyCamImportPlan returns the same summary as totals
  });

  it("does not crash on a CompanyCam project with a null name (treats it as unmatched)", () => {
    const plan = buildCompanyCamImportPlan(
      [
        { id: "cc-null", name: null, photoCount: 5 },
        { id: "cc-fuzzy", name: "North Campus Roofing", photoCount: 7 },
      ],
      PLAN_DEALS,
    );
    const byId = new Map(plan.rows.map((row) => [row.companyCamProjectId, row]));
    expect(byId.get("cc-null")).toMatchObject({ companyCamProjectName: "", matchedDealId: null, matchReason: "unmatched" });
    expect(byId.get("cc-fuzzy")?.matchedDealId).toBe("deal-fuzzy"); // a real-named project still matches alongside the null one
  });
});
