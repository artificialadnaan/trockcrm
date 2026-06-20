// Canonical resolver for the human-facing deal / project number — THE single source of truth
// shared by the CRM web app (client), the field projects API (server), and global search.
//
// Why this exists: `deals.deal_number` is NOT NULL / UNIQUE, but its content depends on the deal's
// origin. For HubSpot-imported deals it holds the meaningless HubSpot id ("HS-318900588242") while
// the canonical DFW/ATL number lives in `deals.project_number`. For bid-board-owned deals the
// canonical number is in `deal_number` and `project_number` is empty. This resolver picks the right
// one and NEVER exposes the HubSpot id. Previously this logic was duplicated in
// client/src/lib/deal-utils.ts and server/src/modules/search/service.ts — both now route here.

const HUBSPOT_DEAL_NUMBER_PATTERN = /^HS[-_ ]?\d+/i;

/** True when the value is a HubSpot-imported deal id (e.g. "HS-318900588242"), which must never be displayed. */
export function isHubspotImportedDealNumber(value: string | null | undefined): boolean {
  if (!value) return false;
  return HUBSPOT_DEAL_NUMBER_PATTERN.test(value.trim());
}

export interface DealDisplayNumber {
  label: string;
  isFallback: boolean;
  isPending: boolean;
}

/**
 * Resolve the human-facing deal / project number:
 *   1) `projectNumber` (trimmed) when present — the canonical operator / HubSpot-mapped number;
 *   2) `dealNumber` (trimmed) ONLY when it is not a HubSpot id;
 *   3) otherwise the `"Pending"` sentinel (`isPending: true`).
 */
export function formatDealDisplayNumber(deal: {
  projectNumber?: string | null;
  dealNumber?: string | null;
}): DealDisplayNumber {
  const projectNumber = deal.projectNumber?.trim();
  if (projectNumber) return { label: projectNumber, isFallback: false, isPending: false };

  const dealNumber = deal.dealNumber?.trim();
  if (dealNumber && !isHubspotImportedDealNumber(dealNumber)) {
    return { label: dealNumber, isFallback: true, isPending: false };
  }

  return { label: "Pending", isFallback: true, isPending: true };
}

/** The canonical display value, or `null` when there is no real number to show (the "pending" case). */
export function resolveDealDisplayNumber(deal: {
  projectNumber?: string | null;
  dealNumber?: string | null;
}): string | null {
  const resolved = formatDealDisplayNumber(deal);
  return resolved.isPending ? null : resolved.label;
}
