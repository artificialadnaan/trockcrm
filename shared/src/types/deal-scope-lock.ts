const SCOPE_LOCKED_DEAL_PATCH_FIELD_VALUES = [
  "name",
  "projectType",
  "projectTypeId",
  "sourceLeadId",
  "workflowRoute",
] as const;

const SCOPE_LOCKED_RESOLVED_FIELD_VALUES = [
  "projectTypeId",
  "propertyName",
  "workflowRoute",
  "preBidMeetingCompleted",
  "siteVisitDecision",
  "siteVisitCompleted",
  "estimatorConsultationNotes",
] as const;

const SCOPE_LOCKED_WORKSPACE_TOP_LEVEL_FIELD_VALUES = [
  "projectTypeId",
] as const;

const SCOPE_LOCKED_WORKSPACE_SECTION_VALUES = [
  "opportunity",
  "scope",
  "attachments",
] as const;

const SCOPE_LOCKED_WORKSPACE_FIELD_VALUES = [
  "projectOverview.propertyName",
] as const;

const SCOPE_LOCKED_ATTACHMENT_KEY_VALUES = [
  "scope_docs",
  "site_photos",
] as const;

const SCOPE_LOCKED_FILE_ACTION_VALUES = [
  "link_existing",
  "new_version",
  "delete",
  "restore",
] as const;

export const SCOPE_LOCKED_DEAL_PATCH_FIELDS = new Set<string>(SCOPE_LOCKED_DEAL_PATCH_FIELD_VALUES);
export const SCOPE_LOCKED_RESOLVED_FIELDS = new Set<string>(SCOPE_LOCKED_RESOLVED_FIELD_VALUES);
export const SCOPE_LOCKED_WORKSPACE_TOP_LEVEL_FIELDS = new Set<string>(SCOPE_LOCKED_WORKSPACE_TOP_LEVEL_FIELD_VALUES);
export const SCOPE_LOCKED_WORKSPACE_SECTIONS = new Set<string>(SCOPE_LOCKED_WORKSPACE_SECTION_VALUES);
export const SCOPE_LOCKED_WORKSPACE_FIELDS = new Set<string>(SCOPE_LOCKED_WORKSPACE_FIELD_VALUES);
export const SCOPE_LOCKED_ATTACHMENT_KEYS = new Set<string>(SCOPE_LOCKED_ATTACHMENT_KEY_VALUES);
export const SCOPE_LOCKED_FILE_ACTIONS = new Set<string>(SCOPE_LOCKED_FILE_ACTION_VALUES);

function normalizeComparableValue(value: unknown): unknown {
  if (value == null) return null;

  if (typeof value === "string") {
    return value.length === 0 ? null : value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeComparableValue(entry))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, normalizeComparableValue(entryValue)])
    );
  }

  return value;
}

function comparableValuesEqual(left: unknown, right: unknown) {
  return JSON.stringify(normalizeComparableValue(left)) === JSON.stringify(normalizeComparableValue(right));
}

export function getScopeLockedDealPatchFields(
  body: Record<string, unknown>,
  existing: Record<string, unknown>
) {
  return Object.keys(body).filter(
    (field) =>
      SCOPE_LOCKED_DEAL_PATCH_FIELDS.has(field) &&
      !comparableValuesEqual(body[field], existing[field])
  );
}

export function getScopeLockedResolvedFields(
  patch: Record<string, unknown>,
  existing: Record<string, unknown>
) {
  return Object.keys(patch).filter(
    (field) =>
      SCOPE_LOCKED_RESOLVED_FIELDS.has(field) &&
      !comparableValuesEqual(patch[field], existing[field])
  );
}

export function isScopeLockedWorkspaceTopLevelField(field: string) {
  return SCOPE_LOCKED_WORKSPACE_TOP_LEVEL_FIELDS.has(field);
}

export function isScopeLockedWorkspaceSection(section: string) {
  return SCOPE_LOCKED_WORKSPACE_SECTIONS.has(section);
}

export function isScopeLockedWorkspaceField(section: string, field: string) {
  return (
    isScopeLockedWorkspaceSection(section) ||
    SCOPE_LOCKED_WORKSPACE_FIELDS.has(`${section}.${field}`)
  );
}

export function isScopeLockedAttachmentKey(key: string | null | undefined) {
  return typeof key === "string" && SCOPE_LOCKED_ATTACHMENT_KEYS.has(key);
}

export function isScopeLockedFileAction(input: {
  action: string;
  intakeRequirementKey?: string | null;
  intakeSource?: string | null;
}) {
  return (
    input.intakeSource === "scoping_intake" &&
    isScopeLockedAttachmentKey(input.intakeRequirementKey) &&
    SCOPE_LOCKED_FILE_ACTIONS.has(input.action)
  );
}
