/**
 * The human-facing deal / project number.
 *
 * A MIRROR of `shared/src/types/deal-display-number.ts`, for the same reason `ESTIMATING_STAGE_SLUGS`
 * is one: mobile-crm is deliberately outside the npm workspace, so Metro resolves from its own
 * node_modules and cannot reach shared/. Kept to the resolver alone so the drift surface is one rule
 * rather than a module.
 *
 * WHY A RULE AND NOT `projectNumber ?? dealNumber`. `deals.deal_number` is NOT NULL, but what it holds
 * depends on the deal's origin:
 *
 *   - HubSpot-imported: `deal_number` is the meaningless HubSpot id ("HS-318900588242") and the
 *     canonical DFW/ATL number lives in `project_number`. The HubSpot id must NEVER be displayed.
 *   - Bid-board-owned: the canonical number is in `deal_number` and `project_number` is EMPTY —
 *     empty string, not null, so `??` keeps it and the real number is thrown away.
 *
 * Nullish coalescing gets both cases wrong in opposite directions: it prefers `""` over a valid deal
 * number, and falls through to a HubSpot id when there is no project number.
 */

const HUBSPOT_DEAL_NUMBER_PATTERN = /^HS[-_ ]?\d+/i;

/** True for a HubSpot-imported id, which is an internal identifier and must not reach a screen. */
export function isHubspotImportedDealNumber(value: string | null | undefined): boolean {
  if (!value) return false;
  return HUBSPOT_DEAL_NUMBER_PATTERN.test(value.trim());
}

/**
 * The number to show, or null when there is not one yet.
 *
 * Null rather than a "Pending" string: the callers here compose a metadata line from parts and drop
 * the empty ones, so a sentinel would render as a word in a list of real values.
 */
export function resolveDealDisplayNumber(deal: {
  projectNumber?: string | null;
  dealNumber?: string | null;
}): string | null {
  const projectNumber = deal.projectNumber?.trim();
  if (projectNumber) return projectNumber;

  const dealNumber = deal.dealNumber?.trim();
  if (dealNumber && !isHubspotImportedDealNumber(dealNumber)) return dealNumber;

  return null;
}
