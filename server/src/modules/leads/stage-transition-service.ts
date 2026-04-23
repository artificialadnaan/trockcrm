import {
  isAnsweredLeadValidationValue,
  listRequiredLeadQualificationFieldIds,
  listRequiredLeadQuestionIds,
} from "./validation-question-service.js";

export interface LeadStageTransitionLead {
  id: string;
  stageId: string;
  stageSlug: string | null;
  source?: string | null;
  projectTypeId: string | null;
  qualificationPayload: Record<string, string | boolean | number | null>;
  projectTypeQuestionPayload: {
    projectTypeId: string | null;
    answers: Record<string, string | boolean | number | null>;
  };
}

export interface LeadStageTransitionStage {
  id: string;
  slug: string;
  name: string;
  isTerminal: boolean;
  displayOrder: number;
}

export interface LeadStageTransitionResult {
  allowed: boolean;
  code: "LEAD_STAGE_REQUIREMENTS_UNMET" | null;
  message: string | null;
  currentStage: LeadStageTransitionStage;
  targetStage: LeadStageTransitionStage;
  missingRequirements: {
    prerequisiteFields: string[];
    qualificationFields: string[];
    projectTypeQuestionIds: string[];
  };
}

export class LeadStageTransitionError extends Error {
  statusCode = 409;
  code = "LEAD_STAGE_REQUIREMENTS_UNMET" as const;

  constructor(public result: LeadStageTransitionResult) {
    super(result.message ?? "Lead stage requirements are not met");
    this.name = "LeadStageTransitionError";
  }
}

interface ValidateLeadStageTransitionInput {
  lead: LeadStageTransitionLead;
  currentStage: LeadStageTransitionStage;
  targetStage: LeadStageTransitionStage;
  projectTypeSlug: string | null;
}

function shouldValidateSalesQualificationGate(
  currentStage: LeadStageTransitionStage,
  targetStage: LeadStageTransitionStage
) {
  return (
    currentStage.slug === "sales_validation_stage" &&
    targetStage.displayOrder > currentStage.displayOrder
  );
}

function listQualifiedLeadPrerequisiteFields(lead: LeadStageTransitionLead) {
  const qualificationPayload = lead.qualificationPayload ?? {};
  const missingFields: string[] = [];

  if (!isAnsweredLeadValidationValue(lead.source)) {
    missingFields.push("source");
  }

  if (!isAnsweredLeadValidationValue(lead.projectTypeId)) {
    missingFields.push("projectTypeId");
  }

  if (!isAnsweredLeadValidationValue(qualificationPayload.existing_customer_status)) {
    missingFields.push("qualificationPayload.existing_customer_status");
  }

  return missingFields;
}

export function validateLeadStageTransition(
  input: ValidateLeadStageTransitionInput
): LeadStageTransitionResult {
  const { lead, currentStage, targetStage, projectTypeSlug } = input;
  const qualificationPayload = lead.qualificationPayload ?? {};
  const questionAnswers = lead.projectTypeQuestionPayload?.answers ?? {};

  if (targetStage.slug === "qualified_lead") {
    const prerequisiteFields = listQualifiedLeadPrerequisiteFields(lead);
    const allowed = prerequisiteFields.length === 0;

    return {
      allowed,
      code: allowed ? null : "LEAD_STAGE_REQUIREMENTS_UNMET",
      message: allowed
        ? null
        : "Complete the lead intake fields before moving this lead to Qualified Lead.",
      currentStage,
      targetStage,
      missingRequirements: {
        prerequisiteFields,
        qualificationFields: [],
        projectTypeQuestionIds: [],
      },
    };
  }

  if (!shouldValidateSalesQualificationGate(currentStage, targetStage)) {
    return {
      allowed: true,
      code: null,
      message: null,
      currentStage,
      targetStage,
      missingRequirements: {
        prerequisiteFields: [],
        qualificationFields: [],
        projectTypeQuestionIds: [],
      },
    };
  }

  const qualificationFields = listRequiredLeadQualificationFieldIds().filter(
    (fieldId) => !isAnsweredLeadValidationValue(qualificationPayload[fieldId])
  );
  const projectTypeQuestionIds = listRequiredLeadQuestionIds(projectTypeSlug).filter(
    (questionId) => !isAnsweredLeadValidationValue(questionAnswers[questionId])
  );

  const allowed = qualificationFields.length === 0 && projectTypeQuestionIds.length === 0;

  return {
    allowed,
    code: allowed ? null : "LEAD_STAGE_REQUIREMENTS_UNMET",
    message: allowed
      ? null
      : "Complete the Sales Validation Stage qualification fields and Top 5 Questions before moving this lead forward.",
    currentStage,
    targetStage,
    missingRequirements: {
      prerequisiteFields: [],
      qualificationFields,
      projectTypeQuestionIds,
    },
  };
}

export function assertLeadStageTransitionAllowed(
  input: ValidateLeadStageTransitionInput
): LeadStageTransitionResult {
  const result = validateLeadStageTransition(input);

  if (!result.allowed) {
    throw new LeadStageTransitionError(result);
  }

  return result;
}
