import type {
  LeadValidationAnswerValue as ValidationQuestionAnswerValue,
  LeadValidationQuestionDefinition as ValidationQuestionDefinition,
  LeadValidationQuestionSet as ValidationQuestionSet,
} from "@trock-crm/shared/types";
import {
  getLeadValidationQuestionSetForProjectType as getSharedLeadValidationQuestionSetForProjectType,
  LEAD_QUALIFICATION_FIELDS,
} from "@trock-crm/shared/types";

export function getValidationQuestionSetForProjectType(
  projectTypeSlug: string | null | undefined
): ValidationQuestionSet {
  return getSharedLeadValidationQuestionSetForProjectType(projectTypeSlug);
}

export function getValidationQuestionSetQuestionIds(projectTypeSlug: string | null | undefined): string[] {
  return getValidationQuestionSetForProjectType(projectTypeSlug).questions.map((question) => question.id);
}

export function getVisibleValidationQuestions(projectTypeSlug: string | null | undefined) {
  return getValidationQuestionSetForProjectType(projectTypeSlug).questions;
}

export function isAnsweredValidationQuestionValue(value: ValidationQuestionAnswerValue | undefined): boolean {
  if (value == null) {
    return false;
  }

  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  return true;
}
