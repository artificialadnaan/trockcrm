export interface PropertyKeyInput {
  companyId?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}

export function normalizePropertyText(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function buildPropertySignature(input: PropertyKeyInput): string {
  const parts = [input.address, input.city, input.state, input.zip]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));

  return [
    normalizePropertyText(input.companyId),
    ...parts.map((part) => normalizePropertyText(part)),
  ]
    .filter(Boolean)
    .join("--");
}

function hashString(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

export function buildPropertyId(input: PropertyKeyInput): string {
  const signature = buildPropertySignature(input);
  const suffix = hashString(signature || "unassigned-property");
  const label = normalizePropertyText(input.address) || "property";
  return `property-${label || "property"}-${suffix}`;
}

export function formatPropertyLabel(input: PropertyKeyInput): string {
  const parts = [input.address, [input.city, input.state].filter(Boolean).join(", "), input.zip]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));

  return parts.join(", ") || "Unassigned Property";
}
