// T-Rock Construction weekly Field Scorecard — canonical scoring model.
// Transcribed verbatim from the paper form (TRC_05_Field Scorecard). This is the single
// source of truth for the 7 sections, their point options, the rating bands, and the
// action-item gate; the mobile app, server, worker, and CRM web all import from here so
// the scoring can never drift between surfaces.

export const FIELD_SCORECARD_SECTION_KEYS = [
  "planning_precon",
  "jobsite_5s",
  "schedule",
  "subcontractor",
  "quality",
  "communication",
  "financial",
] as const;
export type ScorecardSectionKey = (typeof FIELD_SCORECARD_SECTION_KEYS)[number];

export interface ScorecardSectionOption {
  points: number;
  label: string;
}
export interface ScorecardSectionDef {
  key: ScorecardSectionKey;
  title: string;
  maxPoints: number;
  options: readonly ScorecardSectionOption[];
}

/** The 7 scored sections, in the order they appear on the form; max points sum to 100. */
export const FIELD_SCORECARD_SECTIONS: readonly ScorecardSectionDef[] = [
  {
    key: "planning_precon",
    title: "Planning & Precon",
    maxPoints: 10,
    options: [
      { points: 10, label: "Scope, schedule, and logistics fully aligned" },
      { points: 5, label: "Minor gaps requiring follow-up" },
      { points: 0, label: "Major gaps impacting execution" },
    ],
  },
  {
    key: "jobsite_5s",
    title: "Jobsite Organization / 5S",
    maxPoints: 15,
    options: [
      { points: 15, label: "Clean, organized, and fully controlled" },
      { points: 10, label: "Minor housekeeping or staging issues" },
      { points: 5, label: "Disorganized areas affecting production" },
      { points: 0, label: "Poor site condition or lack of control" },
    ],
  },
  {
    key: "schedule",
    title: "Schedule Performance",
    maxPoints: 20,
    options: [
      { points: 20, label: "On schedule and meeting milestones" },
      { points: 15, label: "Minor slippage with recovery in progress" },
      { points: 10, label: "Behind schedule without full recovery" },
      { points: 0, label: "Off track and impacting project progress" },
    ],
  },
  {
    key: "subcontractor",
    title: "Subcontractor Performance",
    maxPoints: 15,
    options: [
      { points: 15, label: "Performing to plan and expectations" },
      { points: 10, label: "Minor coordination or manpower issues" },
      { points: 5, label: "Performance impacting production or quality" },
      { points: 0, label: "Major performance failure" },
    ],
  },
  {
    key: "quality",
    title: "Quality Control",
    maxPoints: 20,
    options: [
      { points: 20, label: "Hold points completed with no deficiencies" },
      { points: 15, label: "Minor corrections required" },
      { points: 10, label: "Rework or repeated deficiencies present" },
      { points: 0, label: "Major quality or inspection failures" },
    ],
  },
  {
    key: "communication",
    title: "Communication & Documentation",
    maxPoints: 10,
    options: [
      { points: 10, label: "Reports, updates, and documentation current" },
      { points: 5, label: "Minor communication gaps" },
      { points: 0, label: "Missing, late, or inconsistent reporting" },
    ],
  },
  {
    key: "financial",
    title: "Financial Control",
    maxPoints: 10,
    options: [
      { points: 10, label: "Costs aligned with budget and production" },
      { points: 5, label: "Minor cost variance or unresolved exposure" },
      { points: 0, label: "Budget concerns or uncontrolled costs" },
    ],
  },
];

export const FIELD_SCORECARD_TOTAL_POINTS = 100;

/** "Check all that apply" critical deficiencies from the form. */
export const FIELD_SCORECARD_CRITICAL_DEFICIENCIES = [
  { key: "missed_hold_point", label: "Missed hold point" },
  { key: "failed_inspection", label: "Failed inspection" },
  { key: "schedule_slipping", label: "Schedule slipping without recovery plan" },
  { key: "site_org_below", label: "Site organization below standard" },
  { key: "unapproved_co", label: "Unapproved Change Order work" },
  { key: "safety_access", label: "Safety or access issue" },
  { key: "poor_sub", label: "Poor subcontractor performance" },
  { key: "missing_docs", label: "Missing documentation or reporting" },
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

export interface ScorecardRatingBand {
  rating: ScorecardRating;
  min: number;
  max: number;
  label: string;
}
/** Project rating bands from the form. */
export const FIELD_SCORECARD_RATING_BANDS: readonly ScorecardRatingBand[] = [
  { rating: "elite", min: 90, max: 100, label: "Elite Execution" },
  { rating: "on_standard", min: 85, max: 89, label: "On Standard" },
  { rating: "needs_improvement", min: 75, max: 84, label: "Needs Immediate Improvement" },
  { rating: "corrective_action", min: 0, max: 74, label: "Corrective Action Required" },
];

const RATING_LABEL: Record<ScorecardRating, string> = {
  elite: "Elite Execution",
  on_standard: "On Standard",
  needs_improvement: "Needs Immediate Improvement",
  corrective_action: "Corrective Action Required",
};
export function scorecardRatingLabel(rating: ScorecardRating): string {
  return RATING_LABEL[rating];
}

const SECTION_BY_KEY: Record<ScorecardSectionKey, ScorecardSectionDef> = Object.fromEntries(
  FIELD_SCORECARD_SECTIONS.map((s) => [s.key, s]),
) as Record<ScorecardSectionKey, ScorecardSectionDef>;

export function isScorecardSectionKey(key: string): key is ScorecardSectionKey {
  return Object.prototype.hasOwnProperty.call(SECTION_BY_KEY, key);
}

const DEFICIENCY_KEYS = new Set<string>(FIELD_SCORECARD_CRITICAL_DEFICIENCIES.map((d) => d.key));
export function isScorecardCriticalDeficiencyKey(
  key: string,
): key is ScorecardCriticalDeficiencyKey {
  return DEFICIENCY_KEYS.has(key);
}

/** True iff `points` is one of the allowed options for the given section. */
export function isLegalSectionPoints(sectionKey: ScorecardSectionKey, points: number): boolean {
  const section = SECTION_BY_KEY[sectionKey];
  if (!section) return false;
  return section.options.some((o) => o.points === points);
}

export interface ScorecardItemInput {
  sectionKey: ScorecardSectionKey;
  points: number;
}
/** Sum the selected points across the provided section selections. */
export function computeScorecardTotal(items: readonly ScorecardItemInput[]): number {
  return items.reduce((sum, item) => sum + item.points, 0);
}

/** Map a 0–100 total to its rating band. */
export function resolveScorecardRating(total: number): ScorecardRating {
  const band = FIELD_SCORECARD_RATING_BANDS.find((b) => total >= b.min && total <= b.max);
  if (band) return band.rating;
  // Defensive fallback for out-of-range input (validation should keep totals in 0–100).
  return total >= 90 ? "elite" : "corrective_action";
}

/** Action items are required below 85, or when any critical deficiency is flagged. */
export function actionItemsRequired(input: { total: number; deficiencyCount: number }): boolean {
  return input.total < 85 || input.deficiencyCount > 0;
}

// ── Wire types (shared by mobile submit, server persist, and CRM read) ──────────

export interface ScorecardSubmissionItem {
  sectionKey: ScorecardSectionKey;
  points: number;
  note?: string | null;
}
export interface ScorecardPhotoInput {
  sectionKey: ScorecardSectionKey;
  clientUploadId: string;
}
/** POST /field/scorecards body. `clientSubmissionId` makes the offline-retryable submit idempotent. */
export interface ScorecardSubmissionInput {
  clientSubmissionId: string;
  dealId: string;
  weekOf: string; // yyyy-mm-dd
  superintendentName?: string | null;
  pmName?: string | null;
  projectNumber?: string | null;
  items: ScorecardSubmissionItem[];
  criticalDeficiencies: string[];
  actionItems: string[];
  photos: ScorecardPhotoInput[];
}

export interface FieldScorecardSummary {
  id: string;
  dealId: string;
  weekOf: string;
  totalScore: number;
  rating: ScorecardRating;
  ratingLabel: string;
  superintendentName: string | null;
  pmName: string | null;
  projectNumber: string | null;
  criticalDeficiencyCount: number;
  submittedByName: string | null;
  submittedAt: string;
  officeSlug?: string;
  officeId?: string;
}
export interface FieldScorecardPhotoView {
  id: string;
  sectionKey: ScorecardSectionKey;
  fileId: string;
  url: string | null;
  caption: string | null;
}
export interface FieldScorecardItemView {
  sectionKey: ScorecardSectionKey;
  points: number;
  note: string | null;
}
export interface FieldScorecardDetail extends FieldScorecardSummary {
  items: FieldScorecardItemView[];
  criticalDeficiencies: string[];
  actionItems: string[];
  photos: FieldScorecardPhotoView[];
}
