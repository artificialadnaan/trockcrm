function normalizeKeyPart(input: string | null | undefined): string {
  return input?.trim().toLowerCase() ?? "";
}

export function buildPropertyKey(input: {
  companyName?: string | null;
  companyDomain?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}): string {
  const companyContext = normalizeKeyPart(input.companyName) || normalizeKeyPart(input.companyDomain);
  return [companyContext, input.address, input.city, input.state, input.zip]
    .map((part) => normalizeKeyPart(part))
    .join("|");
}
