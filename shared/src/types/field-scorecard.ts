// T-Rock Construction weekly Field Scorecard — canonical scoring model.
// Transcribed verbatim from the paper form (TRC_05_Field Scorecard). This is the single
// source of truth for the 7 sections, their point options, the rating bands, and the
// action-item gate; the server, worker, and CRM web all import from here.
//
// ⚠️ MOBILE MIRROR: the TRCAM app (mobile/) is NOT an npm workspace and cannot import this
// package, so it keeps a verbatim copy at mobile/src/scorecards/scoring.ts guarded by a
// content-snapshot test (mobile/src/scorecards/__tests__/scoring-mirror.test.ts). If you
// edit the sections/labels/points/bands below, update that mirror too or the mobile read
// views will render stale labels — the mobile snapshot test only catches drift made TO the
// mirror, not shared-side edits that forget it.

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

// V2 is the field scorecard form introduced July 2026. V1 definitions above remain exported so
// submitted historical cards can be rendered exactly as they were originally scored.
export const FIELD_SCORECARD_V2_SECTION_KEYS = [
  "planning_precon",
  "jobsite_5s",
  "safety",
  "schedule",
  "subcontractor",
  "quality",
  "communication",
  "financial",
] as const;
export type ScorecardV2SectionKey = (typeof FIELD_SCORECARD_V2_SECTION_KEYS)[number];

export interface ScorecardV2SectionDef {
  key: ScorecardV2SectionKey;
  title: string;
}

/** The V2 one-page form: every category is rated 1-10 and the final score is their average. */
export const FIELD_SCORECARD_V2_SECTIONS: readonly ScorecardV2SectionDef[] = [
  { key: "planning_precon", title: "Planning & Preconstruction" },
  { key: "jobsite_5s", title: "Jobsite Organization / 5S" },
  { key: "safety", title: "Safety" },
  { key: "schedule", title: "Schedule Performance" },
  { key: "subcontractor", title: "Subcontractor Performance" },
  { key: "quality", title: "Quality Control" },
  { key: "communication", title: "Communication & Documentation" },
  { key: "financial", title: "Financial Control" },
];

export const FIELD_SCORECARD_V2_CRITICAL_DEFICIENCIES = [
  { key: "missed_hold_point", label: "Missed hold point" },
  { key: "failed_inspection", label: "Failed inspection" },
  { key: "safety_violation", label: "Safety violation" },
  { key: "schedule_slipping", label: "Schedule slipping without recovery plan" },
  { key: "poor_site_organization", label: "Poor site organization" },
  { key: "unapproved_co", label: "Unapproved change order work" },
  { key: "poor_sub", label: "Poor subcontractor performance" },
  { key: "missing_docs", label: "Missing documentation/reporting" },
] as const;
export type ScorecardV2CriticalDeficiencyKey =
  (typeof FIELD_SCORECARD_V2_CRITICAL_DEFICIENCIES)[number]["key"];

export type ScorecardFormVersion = 1 | 2;

export function isScorecardV2SectionKey(key: string): key is ScorecardV2SectionKey {
  return FIELD_SCORECARD_V2_SECTION_KEYS.includes(key as ScorecardV2SectionKey);
}

export function isScorecardV2CriticalDeficiencyKey(key: string): key is ScorecardV2CriticalDeficiencyKey {
  return FIELD_SCORECARD_V2_CRITICAL_DEFICIENCIES.some((deficiency) => deficiency.key === key);
}

export function computeScorecardV2Average(items: readonly { sectionKey: ScorecardV2SectionKey; points: number }[]): number {
  return Math.round((items.reduce((sum, item) => sum + item.points, 0) / FIELD_SCORECARD_V2_SECTIONS.length) * 10) / 10;
}

export function resolveScorecardV2Rating(average: number): ScorecardRating {
  if (average >= 9) return "elite";
  if (average >= 8) return "on_standard";
  if (average >= 7) return "needs_improvement";
  return "corrective_action";
}

export function scorecardV2RatingLabel(rating: ScorecardRating): string {
  return {
    elite: "Elite Execution",
    on_standard: "Meets Standard",
    needs_improvement: "Needs Improvement",
    corrective_action: "Corrective Action Required",
  }[rating];
}

// ── Leadership scorecard ────────────────────────────────────────────────────────
// A distinct scorecard KIND stored in the same tables (discriminated by `kind`). Four
// categories rated 1-10 with a dictatable comment note; the score is their average out of 10, using the
// same rating bands as V2. Photos may attach to each category or the Project Summary
// (sectionKey `project_summary`). No signatures, no deficiencies.
export type ScorecardKind = "project" | "leadership";

export const FIELD_SCORECARD_LEADERSHIP_SECTION_KEYS = [
  "quality_control",
  "safety",
  "schedule_adherence",
  "site_staff_feedback",
] as const;
export type ScorecardLeadershipSectionKey =
  (typeof FIELD_SCORECARD_LEADERSHIP_SECTION_KEYS)[number];

export interface ScorecardLeadershipSectionDef {
  key: ScorecardLeadershipSectionKey;
  title: string;
  maxPoints: number;
}

/** The 4 leadership categories, each rated 1-10; the final score is their average. */
export const FIELD_SCORECARD_LEADERSHIP_SECTIONS: readonly ScorecardLeadershipSectionDef[] = [
  { key: "quality_control", title: "Quality Control", maxPoints: 10 },
  { key: "safety", title: "Safety", maxPoints: 10 },
  { key: "schedule_adherence", title: "Schedule Adherence", maxPoints: 10 },
  { key: "site_staff_feedback", title: "Site Staff Feedback", maxPoints: 10 },
];

/** The Leadership Project Summary free text and optional summary-only evidence bucket. */
export const FIELD_SCORECARD_LEADERSHIP_SUMMARY_SECTION_KEY = "project_summary" as const;

export function isLeadershipSectionKey(key: string): key is ScorecardLeadershipSectionKey {
  return FIELD_SCORECARD_LEADERSHIP_SECTION_KEYS.includes(key as ScorecardLeadershipSectionKey);
}

export function computeScorecardLeadershipAverage(
  items: readonly { sectionKey: ScorecardLeadershipSectionKey; points: number }[],
): number {
  return (
    Math.round(
      (items.reduce((sum, item) => sum + item.points, 0) /
        FIELD_SCORECARD_LEADERSHIP_SECTIONS.length) *
        10,
    ) / 10
  );
}

export function resolveScorecardLeadershipRating(average: number): ScorecardRating {
  if (average >= 9) return "elite";
  if (average >= 8) return "on_standard";
  if (average >= 7) return "needs_improvement";
  return "corrective_action";
}

export function scorecardLeadershipRatingLabel(rating: ScorecardRating): string {
  return scorecardV2RatingLabel(rating);
}

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
  sectionKey: ScorecardSectionKey | ScorecardV2SectionKey | ScorecardLeadershipSectionKey;
  points: number;
  note?: string | null;
}
export interface ScorecardPhotoInput {
  /**
   * V2 deficiency evidence uses `critical_deficiency` plus `deficiencyKey`.
   * Leadership photos attach to a leadership category or the Project Summary (`project_summary`).
   */
  sectionKey:
    | ScorecardSectionKey
    | ScorecardV2SectionKey
    | ScorecardLeadershipSectionKey
    | "critical_deficiency"
    | "project_summary";
  deficiencyKey?: ScorecardV2CriticalDeficiencyKey | null;
  clientUploadId: string;
}
/** POST /field/scorecards body. `clientSubmissionId` makes the offline-retryable submit idempotent. */
export interface ScorecardSubmissionInput {
  formVersion?: ScorecardFormVersion;
  /** Discriminates project (default) vs leadership scorecards; both share the same tables. */
  kind?: ScorecardKind;
  clientSubmissionId: string;
  dealId: string;
  weekOf: string; // yyyy-mm-dd
  superintendentName?: string | null;
  pmName?: string | null;
  projectNumber?: string | null;
  items: ScorecardSubmissionItem[];
  criticalDeficiencies: string[];
  criticalDeficiencyNotes?: Record<string, string>;
  actionItems: string[];
  photos: ScorecardPhotoInput[];
  superintendentSignature?: string | null;
  pmSignature?: string | null;
  /** Leadership Project Summary free text (voice-dictatable). */
  summary?: string | null;
}

/**
 * One evidence link in a full submitted-scorecard replacement.
 *
 * Existing evidence is addressed by the scorecard-photo link id returned by the detail endpoint, never by
 * an arbitrary file id. Newly captured evidence keeps using the upload queue's client id. The server
 * requires exactly one of these references and re-authorizes either form against the submitted card.
 */
export type ScorecardUpdatePhotoInput =
  | {
      scorecardPhotoId: string;
      clientUploadId?: never;
      sectionKey: ScorecardPhotoInput["sectionKey"];
      deficiencyKey?: ScorecardV2CriticalDeficiencyKey | null;
    }
  | {
      scorecardPhotoId?: never;
      clientUploadId: string;
      sectionKey: ScorecardPhotoInput["sectionKey"];
      deficiencyKey?: ScorecardV2CriticalDeficiencyKey | null;
    };

/**
 * PUT /field/scorecards/:id body. This is a full replacement of the editable form content; record identity,
 * deal, form kind/version, completion week, submitter, and submission timestamps remain immutable.
 */
export interface ScorecardUpdateInput {
  /** Optimistic-concurrency token returned by the latest summary/detail read. */
  expectedUpdatedAt: string;
  superintendentName?: string | null;
  pmName?: string | null;
  items: ScorecardSubmissionItem[];
  criticalDeficiencies: string[];
  criticalDeficiencyNotes?: Record<string, string>;
  actionItems: string[];
  photos: ScorecardUpdatePhotoInput[];
  superintendentSignature?: string | null;
  pmSignature?: string | null;
  /** Leadership Project Summary free text (voice-dictatable). */
  summary?: string | null;
}

export interface FieldScorecardSummary {
  id: string;
  dealId: string;
  weekOf: string;
  totalScore: number;
  formVersion?: ScorecardFormVersion;
  kind?: ScorecardKind;
  averageScore?: number | null;
  rating: ScorecardRating;
  ratingLabel: string;
  superintendentName: string | null;
  pmName: string | null;
  /** Current canonical deal/job name. Optional while older API deployments roll out. */
  projectName?: string | null;
  projectNumber: string | null;
  criticalDeficiencyCount: number;
  submittedByName: string | null;
  submittedAt: string;
  /** Optimistic-concurrency token for submitted-scorecard edits. */
  updatedAt?: string;
  /** UI hint only; the update endpoint independently enforces exact submittedBy UUID ownership. */
  canEdit?: boolean;
  // PDF-availability signal: the field artifact render is best-effort/async and can lag or fail, so the
  // stored PDF key may still be null when the summary is read. `false` → the Download-PDF action would 404;
  // the CRM tab renders a disabled "PDF generating…" state instead of a live link.
  hasPdf: boolean;
  officeSlug?: string;
  officeId?: string;
}
export interface FieldScorecardPhotoView {
  id: string;
  sectionKey:
    | ScorecardSectionKey
    | ScorecardV2SectionKey
    | ScorecardLeadershipSectionKey
    | "critical_deficiency"
    | "project_summary";
  deficiencyKey?: string | null;
  fileId: string;
  url: string | null;
  caption: string | null;
}
export interface FieldScorecardItemView {
  sectionKey: ScorecardSectionKey | ScorecardV2SectionKey | ScorecardLeadershipSectionKey;
  points: number;
  note: string | null;
}
export interface FieldScorecardDetail extends FieldScorecardSummary {
  items: FieldScorecardItemView[];
  criticalDeficiencies: string[];
  criticalDeficiencyNotes?: Record<string, string>;
  actionItems: string[];
  photos: FieldScorecardPhotoView[];
  superintendentSignature?: string | null;
  pmSignature?: string | null;
  /** Leadership Project Summary free text. */
  summary?: string | null;
}
