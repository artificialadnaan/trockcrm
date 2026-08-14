import {
  FIELD_SCORECARD_SECTIONS,
  FIELD_SCORECARD_TOTAL_POINTS,
  FIELD_SCORECARD_CRITICAL_DEFICIENCIES,
  FIELD_SCORECARD_RATING_BANDS,
  FIELD_SCORECARD_LEADERSHIP_SECTIONS,
  FIELD_SCORECARD_LEADERSHIP_SUMMARY_SECTION_KEY,
  computeScorecardAverage,
  computeScorecardLeadershipAverage,
  isLeadershipSectionKey,
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

describe("leadership scorecard scoring mirror", () => {
  it("freezes the four 1-10 leadership categories in the approved order", () => {
    expect(FIELD_SCORECARD_LEADERSHIP_SECTIONS.map((section) => section.key)).toEqual([
      "quality_control", "safety", "schedule_adherence", "site_staff_feedback",
    ]);
    expect(FIELD_SCORECARD_LEADERSHIP_SECTIONS.map((section) => section.title)).toEqual([
      "Quality Control", "Safety", "Schedule Adherence", "Site Staff Feedback",
    ]);
    expect(FIELD_SCORECARD_LEADERSHIP_SECTIONS.map((section) => section.maxPoints)).toEqual(Array(4).fill(10));
    expect(FIELD_SCORECARD_LEADERSHIP_SUMMARY_SECTION_KEY).toBe("project_summary");
  });

  it("recognizes leadership section keys and rejects others", () => {
    expect(isLeadershipSectionKey("quality_control")).toBe(true);
    expect(isLeadershipSectionKey("site_staff_feedback")).toBe(true);
    // A project V2 key is NOT a leadership key (disjoint sets).
    expect(isLeadershipSectionKey("planning_precon")).toBe(false);
    expect(isLeadershipSectionKey("project_summary")).toBe(false);
  });

  it("averages the four categories out of 10 with one-decimal rounding + shared rating bands", () => {
    const items = FIELD_SCORECARD_LEADERSHIP_SECTIONS.map((section, index) => ({
      sectionKey: section.key,
      points: index === 0 ? 9 : 8, // 9,8,8,8 → 33/4 = 8.25 → 8.3
    }));
    expect(computeScorecardLeadershipAverage(items)).toBe(8.3);
    expect(resolveScorecardRating(9)).toBe("elite");
    expect(resolveScorecardRating(6.9)).toBe("corrective_action");
  });
});
