export type DealOfficeCode = "dfw" | "atl";

export interface OfficeCodeSource {
  officeCode?: string | null;
  slug?: string | null;
  name?: string | null;
}

function resolveOfficeCodeFromText(value: string | null | undefined): DealOfficeCode | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return null;

  if (normalized === "atl" || normalized === "atlanta" || normalized.includes("atlanta")) {
    return "atl";
  }

  if (
    normalized === "dfw" ||
    normalized === "dallas" ||
    normalized.includes("dallas") ||
    normalized.includes("fort worth")
  ) {
    return "dfw";
  }

  return null;
}

export function resolveOfficeCodeFromOffice(input: OfficeCodeSource | string | null | undefined): DealOfficeCode | null {
  if (typeof input === "string") {
    return resolveOfficeCodeFromText(input);
  }

  return (
    resolveOfficeCodeFromText(input?.officeCode) ??
    resolveOfficeCodeFromText(input?.slug) ??
    resolveOfficeCodeFromText(input?.name)
  );
}
