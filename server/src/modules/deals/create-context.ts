import { resolveOfficeCodeFromOffice } from "@trock-crm/shared/types";

const NO_ACTIVE_OFFICE_ERROR = "Cannot create deal: no active office. Contact admin.";

export function resolveDealCreateOfficeCode(input: {
  requestedOfficeCode?: unknown;
  officeSlug?: string | null;
}): { officeCode: string } | { error: string } {
  if (input.requestedOfficeCode !== undefined) {
    return {
      officeCode:
        typeof input.requestedOfficeCode === "string"
          ? input.requestedOfficeCode.trim()
          : String(input.requestedOfficeCode ?? ""),
    };
  }

  const officeCode = resolveOfficeCodeFromOffice(input.officeSlug ?? null);
  if (!officeCode) {
    return { error: NO_ACTIVE_OFFICE_ERROR };
  }

  return { officeCode };
}
