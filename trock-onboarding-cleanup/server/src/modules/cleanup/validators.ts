import type { MissingField, RecordDetail, RecordType } from "./types.js";

function present(value: unknown) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function numeric(value: unknown) {
  if (!present(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sourceFlags(record: Record<string, unknown>) {
  const extra = record.hubspot_extra_properties;
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return [];
  const flags = (extra as Record<string, unknown>).leadership_review_flags;
  return Array.isArray(flags) ? flags.map(String) : [];
}

function skipPresent(record: Record<string, unknown>) {
  return present(record.skip_reason);
}

function dealMissing(record: Record<string, unknown>, stageSlug?: string | null): MissingField[] {
  const missing: MissingField[] = [];
  const skipped = skipPresent(record);
  const closed = stageSlug === "won" || stageSlug === "lost";
  const amount = numeric(record.awarded_amount) ?? numeric(record.bid_estimate) ?? numeric(record.dd_estimate);

  if (!present(record.assigned_rep_id)) {
    missing.push({ field: "assigned_rep_id", label: "Owner must be assigned or routed to admin queue", severity: "required" });
  }
  if (!present(record.stage_id)) {
    missing.push({ field: "stage_id", label: "CRM stage is required", severity: "required" });
  }
  if (!present(record.company_id) && !skipped) {
    missing.push({ field: "company_id", label: "Company is required unless skipped with reason", severity: "required" });
  }
  if (!present(record.primary_contact_id) && !skipped) {
    missing.push({ field: "primary_contact_id", label: "Primary contact is required unless skipped with reason", severity: "required" });
  }
  if (!closed && amount === null && !skipped) {
    missing.push({ field: "amount", label: "Active deal needs dd_estimate, bid_estimate, or awarded_amount unless skipped", severity: "required" });
  }
  if (sourceFlags(record).includes("suspect_or_missing_amount")) {
    missing.push({ field: "amount", label: "Amount needs leadership review", severity: "review" });
  }
  if (sourceFlags(record).includes("on_hold_stage_review")) {
    missing.push({ field: "stage_id", label: "On Hold source stage should be reviewed", severity: "review" });
  }

  return missing;
}

function leadMissing(record: Record<string, unknown>): MissingField[] {
  const missing: MissingField[] = [];
  const skipped = skipPresent(record);

  if (!present(record.assigned_rep_id)) {
    missing.push({ field: "assigned_rep_id", label: "Owner must be assigned or routed to admin queue", severity: "required" });
  }
  if (!present(record.company_id)) {
    missing.push({ field: "company_id", label: "Company is required", severity: "required" });
  }
  if (!present(record.property_id)) {
    missing.push({ field: "property_id", label: "Property is required", severity: "required" });
  }
  if (!present(record.primary_contact_id) && !skipped) {
    missing.push({ field: "primary_contact_id", label: "Primary contact is required unless skipped with reason", severity: "required" });
  }
  if (!present(record.stage_id)) {
    missing.push({ field: "stage_id", label: "CRM stage is required", severity: "required" });
  }
  if (!present(record.status)) {
    missing.push({ field: "status", label: "Lead qualification status is required", severity: "required" });
  }

  return missing;
}

function contactMissing(record: Record<string, unknown>): MissingField[] {
  const missing: MissingField[] = [];
  const skipped = skipPresent(record);
  const hasName = present(record.first_name) && present(record.last_name);
  const hasChannel = present(record.email) || present(record.phone) || present(record.mobile);

  if (!hasName && !skipped) {
    missing.push({ field: "name", label: "First and last name are required unless skipped", severity: "required" });
  }
  if (!hasChannel && !skipped) {
    missing.push({ field: "contact_method", label: "Email, phone, or mobile is required unless skipped", severity: "required" });
  }
  if (!present(record.company_id) && !skipped) {
    missing.push({ field: "company_id", label: "Company association is required unless marked orphan/skipped", severity: "required" });
  }

  return missing;
}

function companyMissing(record: Record<string, unknown>): MissingField[] {
  const missing: MissingField[] = [];
  const skipped = skipPresent(record);
  const contactCount = Number(record.associated_contact_count ?? 0);
  const hasAccountSignal = present(record.phone) || present(record.website) || present(record.address) || contactCount > 0;

  if (!present(record.name) && !skipped) {
    missing.push({ field: "name", label: "Company name is required", severity: "required" });
  }
  if (!hasAccountSignal && !skipped) {
    missing.push({
      field: "account_signal",
      label: "Company needs phone, website/domain, address, or associated contact unless skipped",
      severity: "required",
    });
  }

  return missing;
}

export function missingFields(type: RecordType, record: Record<string, unknown>, stageSlug?: string | null): MissingField[] {
  if (type === "deal") return dealMissing(record, stageSlug);
  if (type === "lead") return leadMissing(record);
  if (type === "contact") return contactMissing(record);
  return companyMissing(record);
}

export function blockingMissingFields(detail: RecordDetail) {
  return detail.missingFields.filter((field) => field.severity === "required");
}

export function canComplete(detail: RecordDetail) {
  return blockingMissingFields(detail).length === 0;
}
