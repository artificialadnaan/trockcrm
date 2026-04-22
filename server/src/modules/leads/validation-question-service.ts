export type LeadQuestionAnswerValue = string | boolean | number | null;

export interface LeadValidationQuestion {
  id: string;
  label: string;
  prompt: string;
  input: "text" | "textarea" | "number" | "boolean";
}

export interface LeadValidationQuestionSet {
  key: "service" | "normal";
  title: string;
  questions: LeadValidationQuestion[];
}

const DEFAULT_QUESTION_SET_KEY = "normal";

const QUESTION_SET_BY_KEY: Record<LeadValidationQuestionSet["key"], LeadValidationQuestionSet> = {
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

const QUESTION_SET_KEY_BY_PROJECT_TYPE_SLUG: Record<string, LeadValidationQuestionSet["key"]> = {
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
    input: "text",
  },
] as const;

export type LeadQualificationFieldId = (typeof LEAD_QUALIFICATION_FIELDS)[number]["id"];

function resolveQuestionSetKey(projectTypeSlug: string | null | undefined): LeadValidationQuestionSet["key"] {
  if (!projectTypeSlug) {
    return DEFAULT_QUESTION_SET_KEY;
  }

  return QUESTION_SET_KEY_BY_PROJECT_TYPE_SLUG[projectTypeSlug] ?? DEFAULT_QUESTION_SET_KEY;
}

export function getLeadValidationQuestionSet(
  projectTypeSlug: string | null | undefined
): LeadValidationQuestionSet {
  return QUESTION_SET_BY_KEY[resolveQuestionSetKey(projectTypeSlug)];
}

export function listRequiredLeadQuestionIds(projectTypeSlug: string | null | undefined): string[] {
  return getLeadValidationQuestionSet(projectTypeSlug).questions.map((question) => question.id);
}

export function listRequiredLeadQualificationFieldIds(): LeadQualificationFieldId[] {
  return LEAD_QUALIFICATION_FIELDS.map((field) => field.id);
}

export function isAnsweredLeadValidationValue(value: LeadQuestionAnswerValue | undefined): boolean {
  if (value == null) {
    return false;
  }

  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  return true;
}
