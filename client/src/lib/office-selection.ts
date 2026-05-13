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
