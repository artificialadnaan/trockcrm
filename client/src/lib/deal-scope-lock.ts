/**
 * Shared client signal for "this deal's scope-defining fields are read-only after RFP submission /
 * Bid Board handoff". Mirrors the server's resolveDealScopeLockState (RFP submission OR Bid Board
 * handoff OR past-Opportunity) so the deal edit form and the deal detail page grey out the same
 * fields instead of each maintaining its own copy of the condition.
 *
 * The past-Opportunity signal needs pipeline-stage context the caller already has, so it is passed in.
 */
export interface DealScopeLockSignals {
  rfpApprovalRequestedAt?: string | null;
  rfpApprovalStatus?: string | null;
  bidBoardLinkedAt?: string | null;
  bidBoardProjectNumber?: string | null;
  bidBoardStageEnteredAt?: string | null;
  bidBoardMirrorSourceEnteredAt?: string | null;
  // A mirrored Bid Board stage is itself a handoff marker: the server's inferDealBidBoardOwnership
  // (hasBidBoardSync) treats a bidBoardStageSlug as ownership even when isBidBoardOwned and the handoff
  // timestamps are unset — e.g. legacy mirror rows with only bidBoardStageSlug: "estimate_in_progress".
  bidBoardStageSlug?: string | null;
  isReadOnlyMirror?: boolean | null;
  readOnlySyncedAt?: string | null;
  isBidBoardOwned?: boolean | null;
}

export function isDealScopeReadOnlyAfterRfp(
  deal: DealScopeLockSignals | null | undefined,
  opts?: { isPastOpportunityStage?: boolean }
): boolean {
  if (!deal) return false;
  return Boolean(
    deal.rfpApprovalRequestedAt ||
      deal.rfpApprovalStatus ||
      deal.bidBoardLinkedAt ||
      deal.bidBoardProjectNumber ||
      deal.bidBoardStageEnteredAt ||
      deal.bidBoardMirrorSourceEnteredAt ||
      // Any Bid Board stage slug means the deal is a Bid Board mirror (canonical OR legacy alias like
      // "estimate_in_progress") — treat it as a handoff, matching the server lock, rather than depend on
      // the possibly-stale is_bid_board_owned column.
      deal.bidBoardStageSlug ||
      deal.isReadOnlyMirror ||
      deal.readOnlySyncedAt ||
      deal.isBidBoardOwned ||
      opts?.isPastOpportunityStage
  );
}
