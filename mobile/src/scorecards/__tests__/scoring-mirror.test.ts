import {
  FIELD_SCORECARD_SECTIONS,
  FIELD_SCORECARD_TOTAL_POINTS,
  FIELD_SCORECARD_CRITICAL_DEFICIENCIES,
  FIELD_SCORECARD_RATING_BANDS,
  computeScorecardAverage,
  resolveScorecardRating,
} from "../scoring";

describe("scorecard V2 scoring mirror", () => {
  it("freezes the eight 1-10 categories in the approved form order", () => {
    expect(FIELD_SCORECARD_SECTIONS.map((section) => section.key)).toEqual([
      "planning_precon", "jobsite_5s", "safety", "schedule", "subcontractor", "quality", "communication", "financial",
    ]);
    expect(FIELD_SCORECARD_SECTIONS.map((section) => section.maxPoints)).toEqual(Array(8).fill(10));
    expect(FIELD_SCORECARD_TOTAL_POINTS).toBe(10);
  });

  it("uses the approved V2 critical-deficiency labels", () => {
    expect(FIELD_SCORECARD_CRITICAL_DEFICIENCIES.map((deficiency) => deficiency.key)).toEqual([
      "missed_hold_point", "failed_inspection", "safety_violation", "schedule_slipping",
      "poor_site_organization", "unapproved_co", "poor_sub", "missing_docs",
    ]);
  });

  it("calculates the one-decimal average and rating bands", () => {
    const items = FIELD_SCORECARD_SECTIONS.map((section, index) => ({ sectionKey: section.key, points: index === 0 ? 9 : 8 }));
    expect(computeScorecardAverage(items)).toBe(8.1);
    expect(resolveScorecardRating(9)).toBe("elite");
    expect(resolveScorecardRating(8)).toBe("on_standard");
    expect(resolveScorecardRating(7)).toBe("needs_improvement");
    expect(resolveScorecardRating(6.9)).toBe("corrective_action");
    expect(FIELD_SCORECARD_RATING_BANDS.map((band) => band.label)).toEqual([
      "Elite Execution", "Meets Standard", "Needs Improvement", "Corrective Action Required",
    ]);
  });
});
