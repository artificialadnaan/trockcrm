import { describe, expect, it } from "vitest";
import {
  FIELD_SCORECARD_SECTIONS,
  FIELD_SCORECARD_CRITICAL_DEFICIENCIES,
  FIELD_SCORECARD_TOTAL_POINTS,
  computeScorecardTotal,
  resolveScorecardRating,
  scorecardRatingLabel,
  actionItemsRequired,
  isLegalSectionPoints,
  type ScorecardSectionKey,
} from "./field-scorecard.js";

// A full, legal set of section selections (one per section) used across the total/rating tests.
function selections(points: Partial<Record<ScorecardSectionKey, number>>) {
  return FIELD_SCORECARD_SECTIONS.map((s) => ({
    sectionKey: s.key,
    points: points[s.key] ?? s.maxPoints,
  }));
}

describe("field scorecard definition", () => {
  it("has the 7 sections from the paper form, in order, summing to 100", () => {
    expect(FIELD_SCORECARD_SECTIONS.map((s) => s.key)).toEqual([
      "planning_precon",
      "jobsite_5s",
      "schedule",
      "subcontractor",
      "quality",
      "communication",
      "financial",
    ]);
    const totalMax = FIELD_SCORECARD_SECTIONS.reduce((sum, s) => sum + s.maxPoints, 0);
    expect(totalMax).toBe(100);
    expect(FIELD_SCORECARD_TOTAL_POINTS).toBe(100);
  });

  it("matches the exact max points per section", () => {
    const maxByKey = Object.fromEntries(FIELD_SCORECARD_SECTIONS.map((s) => [s.key, s.maxPoints]));
    expect(maxByKey).toEqual({
      planning_precon: 10,
      jobsite_5s: 15,
      schedule: 20,
      subcontractor: 15,
      quality: 20,
      communication: 10,
      financial: 10,
    });
  });

  it("each section's options are descending, lead with its max, and end at 0", () => {
    for (const s of FIELD_SCORECARD_SECTIONS) {
      const pts = s.options.map((o) => o.points);
      expect(pts[0]).toBe(s.maxPoints);
      expect(pts[pts.length - 1]).toBe(0);
      expect([...pts]).toEqual([...pts].sort((a, b) => b - a));
      for (const o of s.options) expect(o.label.length).toBeGreaterThan(0);
    }
  });

  it("lists the 8 critical deficiencies from the form", () => {
    expect(FIELD_SCORECARD_CRITICAL_DEFICIENCIES).toHaveLength(8);
    expect(FIELD_SCORECARD_CRITICAL_DEFICIENCIES.map((d) => d.key)).toContain("failed_inspection");
    expect(FIELD_SCORECARD_CRITICAL_DEFICIENCIES.map((d) => d.key)).toContain("unapproved_co");
  });
});

describe("computeScorecardTotal", () => {
  it("sums the selected points across sections", () => {
    expect(computeScorecardTotal(selections({}))).toBe(100); // all max
    expect(
      computeScorecardTotal(
        selections({ schedule: 10, quality: 15, subcontractor: 10, jobsite_5s: 10 }),
      ),
    ).toBe(10 + 10 + 10 + 10 + 15 + 10 + 10); // 75
  });

  it("treats an explicit 0 as a real selection, not missing", () => {
    expect(computeScorecardTotal([{ sectionKey: "planning_precon", points: 0 }])).toBe(0);
  });
});

describe("resolveScorecardRating", () => {
  it("maps totals to the four bands at their boundaries", () => {
    expect(resolveScorecardRating(100)).toBe("elite");
    expect(resolveScorecardRating(90)).toBe("elite");
    expect(resolveScorecardRating(89)).toBe("on_standard");
    expect(resolveScorecardRating(85)).toBe("on_standard");
    expect(resolveScorecardRating(84)).toBe("needs_improvement");
    expect(resolveScorecardRating(75)).toBe("needs_improvement");
    expect(resolveScorecardRating(74)).toBe("corrective_action");
    expect(resolveScorecardRating(0)).toBe("corrective_action");
  });

  it("exposes human labels for each rating", () => {
    expect(scorecardRatingLabel("elite")).toBe("Elite Execution");
    expect(scorecardRatingLabel("on_standard")).toBe("On Standard");
    expect(scorecardRatingLabel("needs_improvement")).toBe("Needs Immediate Improvement");
    expect(scorecardRatingLabel("corrective_action")).toBe("Corrective Action Required");
  });
});

describe("actionItemsRequired gate", () => {
  it("requires action items below 85", () => {
    expect(actionItemsRequired({ total: 84, deficiencyCount: 0 })).toBe(true);
  });
  it("requires action items when any deficiency is flagged, even at a high score", () => {
    expect(actionItemsRequired({ total: 100, deficiencyCount: 1 })).toBe(true);
  });
  it("does not require them at/above 85 with no deficiencies", () => {
    expect(actionItemsRequired({ total: 85, deficiencyCount: 0 })).toBe(false);
    expect(actionItemsRequired({ total: 90, deficiencyCount: 0 })).toBe(false);
  });
});

describe("isLegalSectionPoints", () => {
  it("accepts a value that is one of the section's options", () => {
    expect(isLegalSectionPoints("schedule", 20)).toBe(true);
    expect(isLegalSectionPoints("schedule", 10)).toBe(true);
    expect(isLegalSectionPoints("subcontractor", 5)).toBe(true);
    expect(isLegalSectionPoints("planning_precon", 0)).toBe(true);
  });
  it("rejects a value that is not an option for that section", () => {
    expect(isLegalSectionPoints("schedule", 5)).toBe(false); // schedule has no 5
    expect(isLegalSectionPoints("planning_precon", 15)).toBe(false); // max is 10
    expect(isLegalSectionPoints("schedule", 21)).toBe(false);
  });
  it("rejects an unknown section key", () => {
    expect(isLegalSectionPoints("bogus" as ScorecardSectionKey, 10)).toBe(false);
  });
});
