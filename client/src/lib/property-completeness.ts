export type PropertyRequiredField = "address" | "city" | "state" | "zip" | "buildYear" | "unitCount";

export function maxPropertyBuildYear(now: Date = new Date()): number {
  return now.getFullYear() + 2;
}
export function isValidBuildYear(value: unknown, maxYear: number = maxPropertyBuildYear()): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 1800 && value <= maxYear;
}
export function isPositiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
function clean(value: string | null | undefined): string { return value?.trim() ?? ""; }
export interface PropertyCompletenessInput {
  address?: string | null; city?: string | null; state?: string | null; zip?: string | null;
  buildYear?: number | null; unitCount?: number | null;
}
export function getMissingPropertyFields(
  property: PropertyCompletenessInput,
  options: { requireLeadCreate: boolean }
): PropertyRequiredField[] {
  const missing: PropertyRequiredField[] = [];
  if (!clean(property.address)) missing.push("address");
  if (!clean(property.city)) missing.push("city");
  if (!/^[A-Z]{2}$/.test(clean(property.state).toUpperCase())) missing.push("state");
  if (!/^\d{5}(-\d{4})?$/.test(clean(property.zip))) missing.push("zip");
  if (options.requireLeadCreate) {
    if (!isValidBuildYear(property.buildYear ?? null)) missing.push("buildYear");
    if (!isPositiveInteger(property.unitCount ?? null)) missing.push("unitCount");
  }
  return missing;
}
