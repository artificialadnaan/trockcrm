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
      deal.isReadOnlyMirror ||
      deal.readOnlySyncedAt ||
      deal.isBidBoardOwned ||
      opts?.isPastOpportunityStage
  );
}
