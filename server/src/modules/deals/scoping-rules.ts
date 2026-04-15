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
  requiredAttachments: DealScopingAttachmentDefinition[];
  requiredAttachmentKeys: string[];
}

export interface DealScopingAttachmentDefinition {
  key: string;
  category: string;
  label: string;
}

export interface DealScopingAttachmentRequirementSnapshot
  extends DealScopingAttachmentDefinition {
  satisfied: boolean;
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
  attachmentRequirements: DealScopingAttachmentRequirementSnapshot[];
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
  const requiredAttachments: DealScopingAttachmentDefinition[] =
    input.workflowRoute === "service"
      ? [
          {
            key: "site_photos",
            category: "photo",
            label: "Site photos",
          },
        ]
      : [
          {
            key: "scope_docs",
            category: "other",
            label: "Scope docs",
          },
          {
            key: "site_photos",
            category: "photo",
            label: "Site photos",
          },
        ];

  return {
    requiredSections: ["projectOverview", "propertyDetails", "scopeSummary", "attachments"],
    requiredFieldsBySection: {
      projectOverview: projectOverviewFields,
      propertyDetails: ["propertyAddress"],
      scopeSummary: ["summary"],
    },
    requiredAttachments,
    requiredAttachmentKeys: requiredAttachments.map((attachment) => attachment.key),
  };
}

export function evaluateScopingReadiness(input: {
  currentStatus: DealScopingIntakeStatus;
  workflowRoute: WorkflowRoute;
  projectTypeId: string | null;
  sectionData: DealScopingSectionData;
  attachments: Iterable<{
    requirementKey: string | null;
    category: string | null;
  }>;
}): DealScopingReadinessSnapshot {
  const rules = getRequiredScopingRules({
    workflowRoute: input.workflowRoute,
    projectTypeId: input.projectTypeId,
    sectionData: input.sectionData,
  });
  const linkedAttachmentPairs = new Set(
    Array.from(input.attachments, (attachment) =>
      `${attachment.requirementKey ?? ""}:${attachment.category ?? ""}`
    )
  );
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

  const attachmentRequirements = rules.requiredAttachments.map((attachment) => ({
    ...attachment,
    satisfied: linkedAttachmentPairs.has(`${attachment.key}:${attachment.category}`),
  }));
  const missingAttachmentKeys = attachmentRequirements
    .filter((attachment) => !attachment.satisfied)
    .map((attachment) => attachment.key);

  for (const attachment of attachmentRequirements) {
    if (!attachment.satisfied) {
      attachmentErrors[attachment.key] = [attachment.category];
    }
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
    attachmentRequirements,
  };
}
