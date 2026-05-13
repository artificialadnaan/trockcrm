import { resolveOfficeCodeFromOffice } from "@trock-crm/shared/types";

function noActiveOfficeError(recordType: string) {
  return `Cannot create ${recordType}: no active office. Contact admin.`;
}

function officeMismatchError(recordType: string) {
  return `Cannot create ${recordType}: officeCode must match the selected office.`;
}

export function resolveCreateOfficeCode(input: {
  requestedOfficeCode?: unknown;
  officeSlug?: string | null;
  recordType?: "deal" | "lead";
}): { officeCode: string } | { error: string } {
  const recordType = input.recordType ?? "deal";
  const activeOfficeCode = resolveOfficeCodeFromOffice(input.officeSlug ?? null);

  if (input.requestedOfficeCode !== undefined) {
    const requestedOfficeCode =
      typeof input.requestedOfficeCode === "string"
        ? input.requestedOfficeCode.trim()
        : String(input.requestedOfficeCode ?? "");
    const normalizedRequestedOfficeCode = requestedOfficeCode.toLowerCase();

    if (normalizedRequestedOfficeCode === "dfw" || normalizedRequestedOfficeCode === "atl") {
      if (!activeOfficeCode) {
        return { error: noActiveOfficeError(recordType) };
      }
      if (normalizedRequestedOfficeCode !== activeOfficeCode) {
        return { error: officeMismatchError(recordType) };
      }
      return { officeCode: normalizedRequestedOfficeCode };
    }

    return { officeCode: requestedOfficeCode };
  }

  if (!activeOfficeCode) {
    return { error: noActiveOfficeError(recordType) };
  }

  return { officeCode: activeOfficeCode };
}

export const resolveDealCreateOfficeCode = resolveCreateOfficeCode;
