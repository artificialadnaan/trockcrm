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
  { id: "cc-fuzzy", name: "North Campus Roofing", photoCount: 40 }, // exact + unique name -> auto (exact_unique_name)
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
    expect(byId.get("cc-fuzzy")).toMatchObject({ matchReason: "exact_unique_name", matchedDealOnHold: false });
    expect(byId.get("cc-unmatched")).toMatchObject({ matchReason: "unmatched", matchedDealOnHold: null });

    expect(companyCamPlanDisposition(byId.get("cc-link")!)).toBe("auto");
    expect(companyCamPlanDisposition(byId.get("cc-num")!)).toBe("auto");
    expect(companyCamPlanDisposition(byId.get("cc-num-onhold")!)).toBe("manual_review"); // reliable tier but on hold
    expect(companyCamPlanDisposition(byId.get("cc-fuzzy")!)).toBe("auto"); // exact AND unique name -> reliable
    expect(companyCamPlanDisposition(byId.get("cc-unmatched")!)).toBe("manual_review");
  });

  it("summarizes auto-seed vs manual-review and on-hold-excluded photo counts", () => {
    const plan = buildCompanyCamImportPlan(PLAN_PROJECTS, PLAN_DEALS);
    const summary = summarizeCompanyCamPlan(plan.rows);

    expect(summary).toMatchObject({ totalProjects: 5, totalPhotos: 150, matchedProjects: 4, unmatchedProjects: 1 });
    expect(summary.byTier.existing_companycam_link).toEqual({ projects: 1, photos: 10 });
    expect(summary.byTier.project_number_in_name).toEqual({ projects: 2, photos: 50 }); // cc-num + cc-num-onhold
    expect(summary.byTier.exact_unique_name).toEqual({ projects: 1, photos: 40 }); // cc-fuzzy (exact + unique)
    expect(summary.byTier.fuzzy_project_name).toEqual({ projects: 0, photos: 0 });
    expect(summary.byTier.unmatched).toEqual({ projects: 1, photos: 50 });
    expect(summary.onHoldExcluded).toEqual({ projects: 1, photos: 30 }); // cc-num-onhold
    expect(summary.autoSeed).toEqual({ projects: 3, photos: 70 }); // cc-link + cc-num + cc-fuzzy (exact-unique)
    expect(summary.manualReview).toEqual({ projects: 2, photos: 80 }); // on-hold + unmatched
    expect(plan.totals).toEqual(summary); // buildCompanyCamImportPlan returns the same summary as totals
  });

  it("classifies exact-unique (auto), ambiguous name-collision (manual), and sub-1.0 fuzzy (manual)", () => {
    const plan = buildCompanyCamImportPlan(
      [
        { id: "cc-uniq", name: "Winkler Apartments", photoCount: 11 }, // exact + unique -> auto
        { id: "cc-collide", name: "Tides North Dallas", photoCount: 22 }, // exact but TWO deals -> manual
        { id: "cc-near", name: "Watersong Villa", photoCount: 33 }, // ~0.94 fuzzy -> manual
      ],
      [
        { id: "d-uniq", name: "Winkler Apartments", dealNumber: "W-1", projectNumber: null, companycamProjectId: null, onHold: false },
        { id: "d-dup-a", name: "Tides North Dallas", dealNumber: "T-1", projectNumber: null, companycamProjectId: null, onHold: false },
        { id: "d-dup-b", name: "Tides North Dallas", dealNumber: "T-2", projectNumber: null, companycamProjectId: null, onHold: false },
        { id: "d-villas", name: "Watersong Villas", dealNumber: "V-1", projectNumber: null, companycamProjectId: null, onHold: false },
      ],
    );
    const byId = new Map(plan.rows.map((row) => [row.companyCamProjectId, row]));

    // exact AND unique -> reliable auto-link
    expect(byId.get("cc-uniq")).toMatchObject({ matchReason: "exact_unique_name", matchedDealId: "d-uniq", confidence: 1 });
    expect(companyCamPlanDisposition(byId.get("cc-uniq")!)).toBe("auto");

    // exact name carried by TWO deals -> ambiguous collision, held for manual (NOT auto, even at confidence 1)
    expect(byId.get("cc-collide")!.matchReason).toBe("fuzzy_project_name");
    expect(companyCamPlanDisposition(byId.get("cc-collide")!)).toBe("manual_review");

    // sub-1.0 fuzzy name guess -> manual
    expect(byId.get("cc-near")!.matchReason).toBe("fuzzy_project_name");
    expect(byId.get("cc-near")!.confidence).toBeGreaterThanOrEqual(0.9);
    expect(byId.get("cc-near")!.confidence).toBeLessThan(1);
    expect(companyCamPlanDisposition(byId.get("cc-near")!)).toBe("manual_review");
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

  it("does not fuzzy-match a null/empty-named project to a deal whose name normalizes to empty", () => {
    const plan = buildCompanyCamImportPlan(
      [{ id: "cc-null", name: null, photoCount: 9 }],
      // "Project" normalizes to "" (the word is stripped) — must NOT tie at confidence 1 with a nameless project.
      [{ id: "deal-empty", name: "Project", dealNumber: "D-0", projectNumber: null, companycamProjectId: null, onHold: false }],
    );
    expect(plan.rows[0]).toMatchObject({ matchedDealId: null, matchReason: "unmatched", confidence: 0 });
  });
});
