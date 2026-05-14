import type { UserRole } from "@trock-crm/shared/types";

export const INTERNAL_ONLY_AUDIT_FIELDS = [
  "rowVersion",
  "lastSyncedAt",
  "internalStatus",
  "updatedAt",
  "stageEnteredAt",
  "bidBoardMirrorSourceEnteredAt",
  "bidBoardMirrorSourceExitedAt",
  "readOnlySyncedAt",
  "isReadOnlyMirror",
  "isReadOnlySyncDirty",
  "verificationRequiredReason",
];

type TransitionKind = "changed" | "set" | "cleared";

export interface RawAuditFieldChange {
  from: unknown;
  to: unknown;
}

export interface FormattedAuditFieldChange {
  key: string;
  label: string;
  fromDisplay: string | null;
  toDisplay: string | null;
  fromFull?: string | null;
  toFull?: string | null;
  transition: TransitionKind;
  masked: boolean;
}

interface AuditFieldDefinition {
  label: string;
  kind?: "currency" | "date" | "enum" | "text";
  sensitiveToLowPermission?: boolean;
  enumLabels?: Record<string, string>;
}

const CURRENCY_FIELDS = new Set([
  "budget",
  "ddEstimate",
  "bidEstimate",
  "awardedAmount",
  "preQualValue",
]);

const DATE_FIELDS = new Set([
  "bidDueDate",
  "expectedCloseDate",
  "contractSignedDate",
  "convertedAt",
  "proposalDraftStartedAt",
]);

const ENUM_LABELS: Record<string, Record<string, string>> = {
  status: {
    open: "Open",
    converted: "Converted",
    disqualified: "Disqualified",
  },
  workflowRoute: {
    normal: "Normal",
    service: "Service",
  },
  budgetStatus: {
    budgeted_q1: "Budgeted Q1",
    budgeted_q2: "Budgeted Q2",
    budgeted_q3: "Budgeted Q3",
    budgeted_q4: "Budgeted Q4",
    not_budgeted: "Not Budgeted",
  },
};

const FIELD_DEFINITIONS: Record<string, AuditFieldDefinition> = {
  awardedAmount: { label: "Awarded Amount", kind: "currency", sensitiveToLowPermission: true },
  bidEstimate: { label: "Bid Estimate", kind: "currency" },
  budget: { label: "Budget", kind: "currency" },
  bidDueDate: { label: "Bid Due Date", kind: "date" },
  contractSignedDate: { label: "Contract Signed Date", kind: "date" },
  ddEstimate: { label: "DD Estimate", kind: "currency" },
  description: { label: "Description", kind: "text" },
  expectedCloseDate: { label: "Expected Close Date", kind: "date" },
  name: { label: "Name" },
  proposalDraftStartedAt: { label: "Proposal Draft Started", kind: "date" },
  stageId: { label: "Stage" },
  status: { label: "Status", kind: "enum", enumLabels: ENUM_LABELS.status },
  workflowRoute: { label: "Workflow Route", kind: "enum", enumLabels: ENUM_LABELS.workflowRoute },
  budgetStatus: { label: "Budget Status", kind: "enum", enumLabels: ENUM_LABELS.budgetStatus },
  assignedRepId: { label: "Assigned Rep" },
};

function titleize(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatCurrency(value: unknown): string | null {
  if (value == null || value === "") return null;
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.replace(/[$,]/g, ""))
        : Number.NaN;
  if (!Number.isFinite(numeric)) return String(value);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: Number.isInteger(numeric) ? 0 : 2,
  }).format(numeric);
}

function formatDate(value: unknown): string | null {
  if (value == null || value === "") return null;
  let date: Date;
  if (value instanceof Date) {
    date = value;
  } else {
    const raw = String(value);
    const plainDateMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (plainDateMatch) {
      const [, year, month, day] = plainDateMatch;
      date = new Date(Number(year), Number(month) - 1, Number(day));
    } else {
      date = new Date(raw);
    }
  }
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function formatEnumValue(key: string, value: unknown): string | null {
  if (value == null || value === "") return null;
  const labels = FIELD_DEFINITIONS[key]?.enumLabels ?? {};
  return labels[String(value)] ?? titleize(String(value));
}

function truncateText(value: string | null): { compact: string | null; full: string | null } {
  if (value == null) return { compact: null, full: null };
  if (value.length <= 60) return { compact: value, full: value };
  return { compact: `${value.slice(0, 60)}...`, full: value };
}

function formatDisplayValue(key: string, value: unknown): { display: string | null; full?: string | null } {
  const definition = FIELD_DEFINITIONS[key];
  const kind = definition?.kind
    ?? (CURRENCY_FIELDS.has(key) ? "currency" : DATE_FIELDS.has(key) ? "date" : undefined);

  if (kind === "currency") return { display: formatCurrency(value) };
  if (kind === "date") return { display: formatDate(value) };
  if (kind === "enum") return { display: formatEnumValue(key, value) };
  if (kind === "text") {
    const text = value == null ? null : String(value);
    const truncated = truncateText(text);
    return { display: truncated.compact, full: truncated.full };
  }

  if (value == null || value === "") return { display: null };
  return { display: String(value) };
}

export function isInternalOnlyAuditField(fieldKey: string): boolean {
  return INTERNAL_ONLY_AUDIT_FIELDS.includes(fieldKey);
}

export function formatAuditFieldChange(
  key: string,
  change: RawAuditFieldChange
): FormattedAuditFieldChange {
  const definition = FIELD_DEFINITIONS[key];
  const fromFormatted = formatDisplayValue(key, change.from);
  const toFormatted = formatDisplayValue(key, change.to);
  const transition: TransitionKind =
    change.from == null && change.to != null
      ? "set"
      : change.from != null && change.to == null
        ? "cleared"
        : "changed";

  return {
    key,
    label: definition?.label ?? titleize(key),
    fromDisplay: fromFormatted.display ?? null,
    toDisplay: toFormatted.display ?? null,
    fromFull: fromFormatted.full,
    toFull: toFormatted.full,
    transition,
    masked: false,
  };
}

export function formatAuditFieldChanges(
  changes: Record<string, RawAuditFieldChange>
): FormattedAuditFieldChange[] {
  return Object.entries(changes)
    .filter(([key]) => !isInternalOnlyAuditField(key))
    .map(([key, value]) => formatAuditFieldChange(key, value));
}

export function redactAuditFieldChangesForRole(
  changes: FormattedAuditFieldChange[],
  role: UserRole
): FormattedAuditFieldChange[] {
  const canSeeSensitive = role === "admin" || role === "director";
  return changes.map((change) => {
    const definition = FIELD_DEFINITIONS[change.key];
    if (canSeeSensitive || !definition?.sensitiveToLowPermission) {
      return change;
    }
    return {
      ...change,
      masked: true,
      fromDisplay: "Restricted",
      toDisplay: "Restricted",
      fromFull: null,
      toFull: null,
    };
  });
}
