// Single source of truth for the "Pending RFP" bucket: deals whose RFP was triggered but not yet
// approved. Mirrors the rfp_approval_status strings written by the trigger/decline flows.
// Note: the failed-delivery status is stored as "send_failed" (not "failed"); "approved" leaves the
// bucket via the stage advance; "cancelled_source_ineligible" is a terminal cancellation (excluded).
export const PENDING_RFP_AWAITING_STATUSES = ["pending_outbox", "pending"] as const;
export const PENDING_RFP_ATTENTION_STATUSES = ["declined", "conflict", "send_failed"] as const;
export const PENDING_RFP_STATUSES = [
  ...PENDING_RFP_AWAITING_STATUSES,
  ...PENDING_RFP_ATTENTION_STATUSES,
] as const;

export type PendingRfpStatus = (typeof PENDING_RFP_STATUSES)[number];
export type PendingRfpSubState = "awaiting" | "attention";

export function pendingRfpSubStateForStatus(
  status: string | null | undefined,
): PendingRfpSubState | null {
  if (!status) return null;
  if ((PENDING_RFP_AWAITING_STATUSES as readonly string[]).includes(status)) return "awaiting";
  if ((PENDING_RFP_ATTENTION_STATUSES as readonly string[]).includes(status)) return "attention";
  return null;
}

export function isPendingRfpDeal(deal: {
  stageSlug?: string | null;
  isBidBoardOwned?: boolean | null;
  rfpApprovalStatus?: string | null;
}): boolean {
  return (
    deal.stageSlug === "opportunity" &&
    deal.isBidBoardOwned === false &&
    pendingRfpSubStateForStatus(deal.rfpApprovalStatus) !== null
  );
}

/**
 * The /deals BOARD's Pending RFP membership rule — stricter than {@link isPendingRfpDeal} and taking the
 * deal's CANONICAL BOARD column slug rather than its raw stage slug.
 *
 * Two extra exclusions the board needs and the plain predicate does not carry:
 *  - `denial_reconfirmed`: the rep re-confirmed the denial, so it is not an open item any more;
 *  - `rfpOverrideState === "approving"`: an in-flight override approval keeps `rfpApprovalStatus` at
 *    "declined" until the SyncHub callback lands. The server queue and the cancel route both exclude it,
 *    so the board must too, or it shows as an actionable Pending RFP card that nothing can act on.
 *
 * SHARED because both sides need it: the client splits the synthetic Pending RFP column out of the
 * Opportunity column with it, and the server computes the column's count/$ aggregate over ALL matching
 * rows with it (the board's card slice is capped, so a count derived from cards would under-report).
 * One predicate, so the column and the number on it cannot disagree.
 */
export function isPendingRfpBoardCard(
  deal: {
    isBidBoardOwned?: boolean | null;
    rfpApprovalStatus?: string | null;
    rfpOverrideDecision?: string | null;
    rfpOverrideState?: string | null;
  },
  canonicalBoardStageSlug: string | null | undefined,
): boolean {
  return (
    canonicalBoardStageSlug === "opportunity" &&
    deal.isBidBoardOwned === false &&
    deal.rfpOverrideDecision !== "denial_reconfirmed" &&
    deal.rfpOverrideState !== "approving" &&
    pendingRfpSubStateForStatus(deal.rfpApprovalStatus) !== null
  );
}
