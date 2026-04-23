import {
  LEAD_SCOPING_ATTACHMENT_KEYS,
  LEAD_SCOPING_ATTACHMENT_VALUES,
  LEAD_SCOPING_FIELD_DEFINITIONS,
  LEAD_SCOPING_SECTION_KEYS,
  LEAD_SCOPING_TRI_STATE_VALUES,
  type LeadScopingCompletionStateEntry,
  type LeadScopingFieldDefinition,
  type LeadScopingReadiness,
  type LeadScopingSectionData,
  type LeadScopingSectionKey,
} from "@trock-crm/shared/types";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeValue(value: unknown): string | null {
  return isNonEmptyString(value) ? value.trim() : null;
}

function isFieldAnswered(field: LeadScopingFieldDefinition, value: unknown) {
  const normalized = normalizeValue(value);
  if (!normalized) {
    return false;
  }

  if (field.type === "tri_state") {
    return LEAD_SCOPING_TRI_STATE_VALUES.includes(normalized as (typeof LEAD_SCOPING_TRI_STATE_VALUES)[number]);
  }

  if (field.type === "attachment") {
    return LEAD_SCOPING_ATTACHMENT_VALUES.includes(
      normalized as (typeof LEAD_SCOPING_ATTACHMENT_VALUES)[number]
    );
  }

  if (field.type === "select") {
    return field.options?.includes(normalized) ?? false;
  }

  return true;
}

export function evaluateLeadScopingReadiness(input: {
  sectionData: LeadScopingSectionData;
  linkedAttachmentKeys: string[];
}): LeadScopingReadiness {
  const completionState: Record<string, LeadScopingCompletionStateEntry> = {};
  const sectionErrors: Record<string, string[]> = {};
  const attachmentErrors: Record<string, string[]> = {};
  const linkedAttachmentKeys = new Set(input.linkedAttachmentKeys);

  for (const sectionKey of LEAD_SCOPING_SECTION_KEYS) {
    const fields = LEAD_SCOPING_FIELD_DEFINITIONS[sectionKey];
    const sectionValues = (input.sectionData?.[sectionKey] ?? {}) as Record<string, unknown>;
    const missingFields: string[] = [];
    const missingAttachments: string[] = [];

    for (const field of fields) {
      const value = sectionValues[field.key];
      if (field.required === false && normalizeValue(value) === null) {
        continue;
      }
      if (!isFieldAnswered(field, value)) {
        missingFields.push(field.key);
        continue;
      }

      if (field.type === "attachment" && normalizeValue(value) === "provided") {
        if (!linkedAttachmentKeys.has(field.key)) {
          missingAttachments.push(field.key);
        }
      }
    }

    completionState[sectionKey] = {
      isComplete: missingFields.length === 0 && missingAttachments.length === 0,
      missingFields,
      missingAttachments,
    };
    sectionErrors[sectionKey] = missingFields;
    attachmentErrors[sectionKey] = missingAttachments;
  }

  const isReadyForGoNoGo = LEAD_SCOPING_SECTION_KEYS.every(
    (sectionKey: LeadScopingSectionKey) => completionState[sectionKey]?.isComplete === true
  );

  return {
    status: isReadyForGoNoGo ? "ready" : "draft",
    isReadyForGoNoGo,
    completionState,
    errors: {
      sections: sectionErrors,
      attachments: attachmentErrors,
    },
  };
}

export { LEAD_SCOPING_ATTACHMENT_KEYS };
