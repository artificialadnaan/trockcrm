import {
  FIELD_SCORECARD_SECTIONS,
  FIELD_SCORECARD_TOTAL_POINTS,
  FIELD_SCORECARD_CRITICAL_DEFICIENCIES,
  FIELD_SCORECARD_RATING_BANDS,
} from "../scoring";

// The mobile scoring model is a HAND-SYNCED MIRROR of shared/src/types/field-scorecard.ts (the Expo
// bundle can't import @trock-crm/shared). No compile-time link exists, so this CONTENT SNAPSHOT is the
// drift guard: the literals below are transcribed VERBATIM from the shared source. If the paper form /
// shared model renames a key, retitles a section, changes points, reorders, or edits a band label, the
// mirror must be re-synced or this fails (locally — mobile is not a CI workspace).

// ── Exact ordered section keys + titles + maxPoints (shared/src/types/field-scorecard.ts) ──
const EXPECTED_SECTIONS: ReadonlyArray<{ key: string; title: string; maxPoints: number }> = [
  { key: "planning_precon", title: "Planning & Precon", maxPoints: 10 },
  { key: "jobsite_5s", title: "Jobsite Organization / 5S", maxPoints: 15 },
  { key: "schedule", title: "Schedule Performance", maxPoints: 20 },
  { key: "subcontractor", title: "Subcontractor Performance", maxPoints: 15 },
  { key: "quality", title: "Quality Control", maxPoints: 20 },
  { key: "communication", title: "Communication & Documentation", maxPoints: 10 },
  { key: "financial", title: "Financial Control", maxPoints: 10 },
];

// ── Exact ordered critical-deficiency keys + labels ──
const EXPECTED_DEFICIENCIES: ReadonlyArray<{ key: string; label: string }> = [
  { key: "missed_hold_point", label: "Missed hold point" },
  { key: "failed_inspection", label: "Failed inspection" },
  { key: "schedule_slipping", label: "Schedule slipping without recovery plan" },
  { key: "site_org_below", label: "Site organization below standard" },
  { key: "unapproved_co", label: "Unapproved Change Order work" },
  { key: "safety_access", label: "Safety or access issue" },
  { key: "poor_sub", label: "Poor subcontractor performance" },
  { key: "missing_docs", label: "Missing documentation or reporting" },
];

// ── Exact ordered rating bands (rating + min + max + label) ──
const EXPECTED_BANDS: ReadonlyArray<{ rating: string; min: number; max: number; label: string }> = [
  { rating: "elite", min: 90, max: 100, label: "Elite Execution" },
  { rating: "on_standard", min: 85, max: 89, label: "On Standard" },
  { rating: "needs_improvement", min: 75, max: 84, label: "Needs Immediate Improvement" },
  { rating: "corrective_action", min: 0, max: 74, label: "Corrective Action Required" },
];

describe("scorecard scoring mirror — content snapshot vs shared source", () => {
  it("freezes the exact 7 sections: order, key, title, and maxPoints", () => {
    expect(
      FIELD_SCORECARD_SECTIONS.map((s) => ({ key: s.key, title: s.title, maxPoints: s.maxPoints })),
    ).toEqual(EXPECTED_SECTIONS);
  });

  it("section max points still total 100 (and the constant agrees)", () => {
    const total = FIELD_SCORECARD_SECTIONS.reduce((sum, s) => sum + s.maxPoints, 0);
    expect(total).toBe(100);
    expect(FIELD_SCORECARD_TOTAL_POINTS).toBe(100);
  });

  it("freezes the exact 8 critical deficiencies: order, key, and label", () => {
    expect(
      FIELD_SCORECARD_CRITICAL_DEFICIENCIES.map((d) => ({ key: d.key, label: d.label })),
    ).toEqual(EXPECTED_DEFICIENCIES);
  });

  it("freezes the exact rating bands: order, rating, min, max, and label", () => {
    expect(
      FIELD_SCORECARD_RATING_BANDS.map((b) => ({ rating: b.rating, min: b.min, max: b.max, label: b.label })),
    ).toEqual(EXPECTED_BANDS);
  });

  it("rating bands cover 0..100 contiguously (structural backstop)", () => {
    const bands = [...FIELD_SCORECARD_RATING_BANDS].sort((a, b) => a.min - b.min);
    expect(bands[0].min).toBe(0);
    expect(bands[bands.length - 1].max).toBe(100);
    for (let i = 1; i < bands.length; i += 1) {
      expect(bands[i].min).toBe(bands[i - 1].max + 1);
    }
  });
});
