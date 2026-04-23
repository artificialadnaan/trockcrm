import type {
  LeadQualificationFieldId,
  LeadValidationAnswerValue as LeadQuestionAnswerValue,
  LeadValidationQuestionSet,
} from "@trock-crm/shared/types";
import {
  getLeadValidationQuestionSetForProjectType,
  LEAD_QUALIFICATION_FIELDS,
} from "@trock-crm/shared/types";

export function getLeadValidationQuestionSet(
  projectTypeSlug: string | null | undefined
): LeadValidationQuestionSet {
  return getLeadValidationQuestionSetForProjectType(projectTypeSlug);
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
