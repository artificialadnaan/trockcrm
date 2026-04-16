function normalizeIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

function extractRawAssociationIds(
  rawData: Record<string, unknown> | null | undefined,
  entityType: "deals" | "contacts"
): string[] {
  const results = rawData?.associations;
  if (!results || typeof results !== "object") return [];

  const bucket = (results as Record<string, unknown>)[entityType];
  if (!bucket || typeof bucket !== "object") return [];

  const rows = (bucket as Record<string, unknown>).results;
  if (!Array.isArray(rows)) return [];

  return rows
    .map((entry) => (entry && typeof entry === "object" ? (entry as Record<string, unknown>).id : null))
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    .map((id) => id.trim());
}

export function getStagedActivityAssociationIds(input: {
  rawData?: Record<string, unknown> | null;
  hubspotDealId?: string | null;
  hubspotDealIds?: unknown;
  hubspotContactId?: string | null;
  hubspotContactIds?: unknown;
}): {
  hubspotDealIds: string[];
  hubspotContactIds: string[];
  hubspotDealId: string | null;
  hubspotContactId: string | null;
  candidateCount: number;
} {
  const dealIds = Array.from(
    new Set([
      ...extractRawAssociationIds(input.rawData, "deals"),
      ...normalizeIdList(input.hubspotDealIds),
      ...(input.hubspotDealId?.trim() ? [input.hubspotDealId.trim()] : []),
    ])
  );

  const contactIds = Array.from(
    new Set([
      ...extractRawAssociationIds(input.rawData, "contacts"),
      ...normalizeIdList(input.hubspotContactIds),
      ...(input.hubspotContactId?.trim() ? [input.hubspotContactId.trim()] : []),
    ])
  );

  return {
    hubspotDealIds: dealIds,
    hubspotContactIds: contactIds,
    hubspotDealId: dealIds[0] ?? null,
    hubspotContactId: contactIds[0] ?? null,
    candidateCount: dealIds.length + contactIds.length,
  };
}
