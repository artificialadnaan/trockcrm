import {
  resolveOfficeCodeFromOffice,
  type DealOfficeCode,
  type OfficeCodeSource,
} from "@trock-crm/shared/types";

export interface OfficeSelectionSource extends OfficeCodeSource {
  id: string;
}

export interface OfficeSelectionOption {
  code: DealOfficeCode;
  label: string;
  officeId: string;
}

export interface OfficeRequestOptions {
  officeId?: string | null;
}

const OFFICE_LABELS: Record<DealOfficeCode, string> = {
  dfw: "DFW (Dallas)",
  atl: "ATL (Atlanta)",
};

const OFFICE_ORDER: DealOfficeCode[] = ["dfw", "atl"];

export function buildOfficeSelectionOptions(offices: OfficeSelectionSource[]): OfficeSelectionOption[] {
  const byCode = new Map<DealOfficeCode, OfficeSelectionSource>();

  for (const office of offices) {
    const code = resolveOfficeCodeFromOffice(office);
    if (code && !byCode.has(code)) {
      byCode.set(code, office);
    }
  }

  return OFFICE_ORDER.flatMap((code) => {
    const office = byCode.get(code);
    return office ? [{ code, label: OFFICE_LABELS[code], officeId: office.id }] : [];
  });
}

/**
 * The office picker is a cosmetic project-number PREFIX chooser (DFW-/ATL-), decoupled from which offices
 * a rep can access and from the data schema: every rep may choose either code, and the choice only sets
 * the deal/lead number prefix — companies/properties/contacts and the created record all stay on the rep's
 * home (active) office. So the picker offers BOTH codes regardless of the rep's accessible offices.
 */
export function buildOfficeCodePrefixOptions(): { code: DealOfficeCode; label: string }[] {
  return OFFICE_ORDER.map((code) => ({ code, label: OFFICE_LABELS[code] }));
}

export function resolveDefaultOfficeCode(input: {
  offices: OfficeSelectionSource[];
  activeOfficeId?: string | null;
  currentOfficeCode?: string | null;
}): DealOfficeCode | "" {
  if (input.currentOfficeCode === "dfw" || input.currentOfficeCode === "atl") {
    return input.currentOfficeCode;
  }

  const activeOffice = input.offices.find((office) => office.id === input.activeOfficeId) ?? null;
  const activeOfficeCode = resolveOfficeCodeFromOffice(activeOffice);
  if (activeOfficeCode) return activeOfficeCode;

  return buildOfficeSelectionOptions(input.offices)[0]?.code ?? "";
}

export function getOfficeRequestOptions(officeId?: string | null) {
  return officeId ? { headers: { "x-office-id": officeId } } : {};
}
