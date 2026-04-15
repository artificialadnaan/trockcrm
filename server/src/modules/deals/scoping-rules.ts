import type { DealScopingIntakeStatus, WorkflowRoute } from "@trock-crm/shared/types";

export interface DealScopingSectionData {
  [sectionKey: string]: unknown;
}

export interface DealScopingRulesInput {
  workflowRoute: WorkflowRoute;
  projectTypeId: string | null;
  sectionData: DealScopingSectionData;
}

export interface DealScopingRules {
  requiredSections: string[];
  requiredFieldsBySection: Record<string, string[]>;
  requiredAttachmentKeys: string[];
}

export interface DealScopingCompletionStateEntry {
  isComplete: boolean;
  missingFields: string[];
  missingAttachments: string[];
}

export interface DealScopingErrors {
  sections: Record<string, string[]>;
  attachments: Record<string, string[]>;
}

export interface DealScopingReadinessSnapshot {
  status: DealScopingIntakeStatus;
  errors: DealScopingErrors;
  completionState: Record<string, DealScopingCompletionStateEntry>;
  requiredSections: string[];
  requiredAttachmentKeys: string[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingRequiredValue(value: unknown): boolean {
  if (value == null) {
    return true;
  }

  if (typeof value === "string") {
    return value.trim().length === 0;
  }

  if (Array.isArray(value)) {
    return value.length === 0;
  }

  return false;
}

export function getRequiredScopingRules(input: DealScopingRulesInput): DealScopingRules {
  const projectOverviewFields =
    input.workflowRoute === "service" ? ["propertyName"] : ["propertyName", "bidDueDate"];

  return {
    requiredSections: ["projectOverview", "propertyDetails", "scopeSummary", "attachments"],
    requiredFieldsBySection: {
      projectOverview: projectOverviewFields,
      propertyDetails: ["propertyAddress"],
      scopeSummary: ["summary"],
    },
    requiredAttachmentKeys: ["scope_docs", "site_photos"],
  };
}

export function evaluateScopingReadiness(input: {
  currentStatus: DealScopingIntakeStatus;
  workflowRoute: WorkflowRoute;
  projectTypeId: string | null;
  sectionData: DealScopingSectionData;
  attachmentKeys: Iterable<string>;
}): DealScopingReadinessSnapshot {
  const rules = getRequiredScopingRules({
    workflowRoute: input.workflowRoute,
    projectTypeId: input.projectTypeId,
    sectionData: input.sectionData,
  });
  const attachmentKeySet = new Set(input.attachmentKeys);
  const sectionErrors: Record<string, string[]> = {};
  const attachmentErrors: Record<string, string[]> = {};
  const completionState: Record<string, DealScopingCompletionStateEntry> = {};

  for (const sectionName of rules.requiredSections) {
    if (sectionName === "attachments") {
      continue;
    }

    const requiredFields = rules.requiredFieldsBySection[sectionName] ?? [];
    const sectionValue = isPlainRecord(input.sectionData[sectionName]) ? input.sectionData[sectionName] : {};
    const missingFields = requiredFields.filter((fieldName) =>
      isMissingRequiredValue(sectionValue[fieldName])
    );

    if (missingFields.length > 0) {
      sectionErrors[sectionName] = missingFields;
    }

    completionState[sectionName] = {
      isComplete: missingFields.length === 0,
      missingFields,
      missingAttachments: [],
    };
  }

  const missingAttachmentKeys = rules.requiredAttachmentKeys.filter(
    (requirementKey) => !attachmentKeySet.has(requirementKey)
  );

  for (const attachmentKey of missingAttachmentKeys) {
    attachmentErrors[attachmentKey] = [attachmentKey];
  }

  completionState.attachments = {
    isComplete: missingAttachmentKeys.length === 0,
    missingFields: [],
    missingAttachments: missingAttachmentKeys,
  };

  const hasErrors = Object.keys(sectionErrors).length > 0 || Object.keys(attachmentErrors).length > 0;
  const status: DealScopingIntakeStatus = hasErrors
    ? "draft"
    : input.currentStatus === "activated"
      ? "activated"
      : "ready";

  return {
    status,
    errors: {
      sections: sectionErrors,
      attachments: attachmentErrors,
    },
    completionState,
    requiredSections: rules.requiredSections,
    requiredAttachmentKeys: rules.requiredAttachmentKeys,
  };
}
