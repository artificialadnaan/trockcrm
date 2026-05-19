type WithMaybeHubspotId = { hubspotDealId?: string | null };

// Output type: original deal (sans hubspotDealId by default) with an injected
// boolean source flag downstream gates can read without ever needing the raw
// HubSpot ID. The flag is derived at response-build time from
// `hubspotDealId != null`, so it stays consistent with whatever the DB has
// without requiring a new column.
export type DealResponseWithSourceFlag<T> = Omit<T, "hubspotDealId"> & {
  hubspotDealId?: string | null;
  isHubspotSourced: boolean;
};

export function shouldIncludeHubspotId(query: Record<string, unknown>, userRole: string): boolean {
  const raw = query.includeHubspotId;
  if (raw !== "true" && raw !== "1") return false;
  return userRole === "admin";
}

export function redactDealResponse<T extends WithMaybeHubspotId>(
  deal: T,
  options: { includeHubspotId: boolean }
): DealResponseWithSourceFlag<T> {
  // The source flag is derived from the underlying hubspot_id field BEFORE
  // we conditionally strip it from the wire response. Once stripped, the
  // client has nothing else to gate on — without this flag, a redacted
  // HubSpot-sourced deal looks identical to a native deal, which is the
  // exact bug Codex caught on round 1 of PR #258.
  const isHubspotSourced = deal.hubspotDealId != null;
  if (options.includeHubspotId) {
    return { ...deal, isHubspotSourced } as DealResponseWithSourceFlag<T>;
  }
  if (!("hubspotDealId" in deal)) {
    return { ...deal, isHubspotSourced } as DealResponseWithSourceFlag<T>;
  }
  const { hubspotDealId: _omitted, ...rest } = deal as T & WithMaybeHubspotId;
  return { ...rest, isHubspotSourced } as DealResponseWithSourceFlag<T>;
}

export function redactDealList<T extends WithMaybeHubspotId>(
  deals: T[],
  options: { includeHubspotId: boolean }
): DealResponseWithSourceFlag<T>[] {
  return deals.map((deal) => redactDealResponse(deal, options));
}

const PRIVATE_DEAL_FIELD_KEYS = [
  "commissionRate",
  "calculatedCommission",
  "commissionSplits",
  "commissionNotes",
  "internalPricingNotes",
  "privateToRep",
] as const;

export function stripPrivateDealFieldsForViewer<T extends Record<string, unknown>>(
  deal: T,
  options: { isOwner: boolean }
) {
  if (options.isOwner) {
    return deal;
  }

  const redacted = { ...deal };
  for (const key of PRIVATE_DEAL_FIELD_KEYS) {
    delete redacted[key];
  }
  return redacted;
}
