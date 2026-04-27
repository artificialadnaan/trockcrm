export type LeadValidationQuestionSetKey = "service" | "normal";
export type LeadValidationAnswerValue = string | boolean | number | null;

export interface LeadValidationQuestionDefinition {
  id: string;
  label: string;
  prompt: string;
  input: "text" | "textarea" | "number" | "boolean";
}

export interface LeadValidationQuestionSet {
  key: LeadValidationQuestionSetKey;
  title: string;
  questions: LeadValidationQuestionDefinition[];
}

export const DEFAULT_LEAD_VALIDATION_QUESTION_SET_KEY: LeadValidationQuestionSetKey = "normal";

export const LEAD_VALIDATION_QUESTION_SETS: Record<
  LeadValidationQuestionSetKey,
  LeadValidationQuestionSet
> = {
  service: {
    key: "service",
    title: "Top 5 Questions",
    questions: [
      {
        id: "service_line",
        label: "Service Line",
        prompt: "What service line is this request tied to?",
        input: "text",
      },
      {
        id: "service_urgency",
        label: "Urgency",
        prompt: "How urgent is the service request?",
        input: "text",
      },
      {
        id: "site_contact_available",
        label: "Site Contact Available",
        prompt: "Is there an on-site contact available for dispatch?",
        input: "boolean",
      },
      {
        id: "active_issue_summary",
        label: "Active Issue",
        prompt: "What issue needs to be solved right now?",
        input: "textarea",
      },
      {
        id: "service_request_value",
        label: "Service Request Value",
        prompt: "What is the expected value of this service request?",
        input: "number",
      },
    ],
  },
  normal: {
    key: "normal",
    title: "Top 5 Questions",
    questions: [
      {
        id: "project_scope",
        label: "Project Scope",
        prompt: "What work is the customer expecting us to deliver?",
        input: "textarea",
      },
      {
        id: "decision_maker",
        label: "Decision Maker",
        prompt: "Who is the decision maker for this opportunity?",
        input: "text",
      },
      {
        id: "budget_status",
        label: "Budget Status",
        prompt: "What is the current budget status?",
        input: "text",
      },
      {
        id: "timeline_target",
        label: "Timeline Target",
        prompt: "When does the customer need this project to move?",
        input: "text",
      },
      {
        id: "incumbent_vendor",
        label: "Incumbent Vendor",
        prompt: "Is an incumbent vendor involved?",
        input: "text",
      },
    ],
  },
};

export const LEAD_VALIDATION_QUESTION_SET_KEY_BY_PROJECT_TYPE_SLUG: Record<
  string,
  LeadValidationQuestionSetKey
> = {
  service: "service",
  commercial: "normal",
  multifamily: "normal",
  restoration: "normal",
  new_construction: "normal",
  land_development: "normal",
  traditional_multifamily: "normal",
  student_housing: "normal",
  senior_living: "normal",
};

export const LEAD_QUALIFICATION_FIELDS = [
  {
    id: "existing_customer_status",
    label: "Existing Customer Status",
    input: "text",
  },
  {
    id: "estimated_value",
    label: "Estimated Value",
    input: "number",
  },
  {
    id: "timeline_status",
    label: "Timeline Status",
    input: "date",
  },
] as const;

export type LeadQualificationFieldId = (typeof LEAD_QUALIFICATION_FIELDS)[number]["id"];

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True for empty / null / whitespace-only.
 */
export function isBlankTimelineStatusValue(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value !== "string") return false;
  return value.trim().length === 0;
}

/**
 * True for already-normalized YYYY-MM-DD strings (after trimming).
 */
export function isValidIsoDate(value: unknown): value is string {
  return typeof value === "string" && ISO_DATE_PATTERN.test(value.trim());
}

/**
 * True for non-empty values that are not normalizable (e.g. "Q1 2026",
 * "next quarter"). Used by the form to surface a "legacy value" hint
 * and block submit until the user picks a real date.
 */
export function isLegacyTimelineStatusValue(value: unknown): boolean {
  if (isBlankTimelineStatusValue(value)) return false;
  return !isValidIsoDate(value);
}

/**
 * Normalize a timeline_status field for persistence.
 *   - blank / whitespace → null
 *   - already-normalized YYYY-MM-DD → returned trimmed
 *   - whitespace-padded YYYY-MM-DD → returned trimmed
 *   - anything else (legacy text, partial dates, alternate formats) → null
 *
 * Idempotent. Caller should treat a non-blank input that returns null as a
 * validation failure that requires the user to pick a real date.
 */
export function normalizeTimelineStatusForSave(value: unknown): string | null {
  if (isBlankTimelineStatusValue(value)) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return ISO_DATE_PATTERN.test(trimmed) ? trimmed : null;
}

export function getLeadValidationQuestionSetForProjectType(
  projectTypeSlug: string | null | undefined
): LeadValidationQuestionSet {
  const key = projectTypeSlug
    ? LEAD_VALIDATION_QUESTION_SET_KEY_BY_PROJECT_TYPE_SLUG[projectTypeSlug] ??
      DEFAULT_LEAD_VALIDATION_QUESTION_SET_KEY
    : DEFAULT_LEAD_VALIDATION_QUESTION_SET_KEY;

  return LEAD_VALIDATION_QUESTION_SETS[key];
}
