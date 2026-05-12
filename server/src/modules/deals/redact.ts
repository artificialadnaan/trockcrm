type WithMaybeHubspotId = { hubspotDealId?: string | null };

export function shouldIncludeHubspotId(query: Record<string, unknown>, userRole: string): boolean {
  const raw = query.includeHubspotId;
  if (raw !== "true" && raw !== "1") return false;
  return userRole === "admin";
}

export function redactDealResponse<T extends WithMaybeHubspotId>(
  deal: T,
  options: { includeHubspotId: boolean }
): T {
  if (options.includeHubspotId) return deal;
  if (!("hubspotDealId" in deal)) return deal;
  const { hubspotDealId: _omitted, ...rest } = deal as T & WithMaybeHubspotId;
  return rest as T;
}

export function redactDealList<T extends WithMaybeHubspotId>(
  deals: T[],
  options: { includeHubspotId: boolean }
): T[] {
  if (options.includeHubspotId) return deals;
  return deals.map((deal) => redactDealResponse(deal, options));
}
