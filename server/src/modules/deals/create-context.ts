import { resolveOfficeCodeFromOffice } from "@trock-crm/shared/types";

function noActiveOfficeError(recordType: string) {
  return `Cannot create ${recordType}: no active office. Contact admin.`;
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
      // The office code is a cosmetic project-number PREFIX, decoupled from the active office / data
      // schema: a Dallas-active rep may stamp ATL (and vice-versa) without changing which records they
      // access. Accept any valid requested code regardless of the active office (no must-match).
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
