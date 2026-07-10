// T-Rock Field Scorecard V2. This mirrors the V2 definitions in
// shared/src/types/field-scorecard.ts; Expo is not part of that workspace.

export const FIELD_SCORECARD_SECTION_KEYS = [
  "planning_precon",
  "jobsite_5s",
  "safety",
  "schedule",
  "subcontractor",
  "quality",
  "communication",
  "financial",
] as const;
export type ScorecardSectionKey = (typeof FIELD_SCORECARD_SECTION_KEYS)[number];

export interface ScorecardSectionDef {
  key: ScorecardSectionKey;
  title: string;
  maxPoints: 10;
}

export const FIELD_SCORECARD_SECTIONS: readonly ScorecardSectionDef[] = [
  { key: "planning_precon", title: "Planning & Preconstruction", maxPoints: 10 },
  { key: "jobsite_5s", title: "Jobsite Organization / 5S", maxPoints: 10 },
  { key: "safety", title: "Safety", maxPoints: 10 },
  { key: "schedule", title: "Schedule Performance", maxPoints: 10 },
  { key: "subcontractor", title: "Subcontractor Performance", maxPoints: 10 },
  { key: "quality", title: "Quality Control", maxPoints: 10 },
  { key: "communication", title: "Communication & Documentation", maxPoints: 10 },
  { key: "financial", title: "Financial Control", maxPoints: 10 },
];

export const FIELD_SCORECARD_TOTAL_POINTS = 10;

export const FIELD_SCORECARD_CRITICAL_DEFICIENCIES = [
  { key: "missed_hold_point", label: "Missed hold point" },
  { key: "failed_inspection", label: "Failed inspection" },
  { key: "safety_violation", label: "Safety violation" },
  { key: "schedule_slipping", label: "Schedule slipping without recovery plan" },
  { key: "poor_site_organization", label: "Poor site organization" },
  { key: "unapproved_co", label: "Unapproved change order work" },
  { key: "poor_sub", label: "Poor subcontractor performance" },
  { key: "missing_docs", label: "Missing documentation/reporting" },
] as const;
export type ScorecardCriticalDeficiencyKey =
  (typeof FIELD_SCORECARD_CRITICAL_DEFICIENCIES)[number]["key"];

export const FIELD_SCORECARD_RATINGS = [
  "elite",
  "on_standard",
  "needs_improvement",
  "corrective_action",
] as const;
export type ScorecardRating = (typeof FIELD_SCORECARD_RATINGS)[number];

export const FIELD_SCORECARD_RATING_BANDS = [
  { rating: "elite", min: 9, max: 10, label: "Elite Execution" },
  { rating: "on_standard", min: 8, max: 8.9, label: "Meets Standard" },
  { rating: "needs_improvement", min: 7, max: 7.9, label: "Needs Improvement" },
  { rating: "corrective_action", min: 0, max: 6.9, label: "Corrective Action Required" },
] as const;

export function scorecardRatingLabel(rating: ScorecardRating): string {
  return {
    elite: "Elite Execution",
    on_standard: "Meets Standard",
    needs_improvement: "Needs Improvement",
    corrective_action: "Corrective Action Required",
  }[rating];
}

export function resolveScorecardRating(average: number): ScorecardRating {
  if (average >= 9) return "elite";
  if (average >= 8) return "on_standard";
  if (average >= 7) return "needs_improvement";
  return "corrective_action";
}

export function isLegalSectionPoints(sectionKey: ScorecardSectionKey, points: number): boolean {
  return FIELD_SCORECARD_SECTION_KEYS.includes(sectionKey) && Number.isInteger(points) && points >= 1 && points <= 10;
}

export function computeScorecardAverage(items: readonly { sectionKey: ScorecardSectionKey; points: number }[]): number {
  return Math.round((items.reduce((sum, item) => sum + item.points, 0) / FIELD_SCORECARD_SECTIONS.length) * 10) / 10;
}
