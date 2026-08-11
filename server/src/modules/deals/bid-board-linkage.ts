/**
 * "Is this deal still bound to Bid Board sync?" — one predicate, one definition.
 *
 * It has two callers that must never disagree: the return-to-opportunity preview + commit (which decide
 * whether to tell the operator to go delete the project themselves, and record `wasBidBoardLinked` in the
 * audit trail) and buildBidBoardOwnershipState in service.ts (which publishes the answer the deal UI
 * renders). They HAVE disagreed before — the preview counted procore_bid_id and the audit flag did not,
 * so a legacy deal whose only footprint is the deliberately preserved Procore identity was told to go
 * delete a project while the audit trail recorded that nothing had been disconnected.
 *
 * IN ITS OWN MODULE rather than exported from return-to-opportunity-service.ts, which is where it lived
 * and where the obvious home would be. service.ts cannot import that file: it would close a cycle
 * (service.ts -> return-to-opportunity-service.ts -> stage-change.ts -> service.ts), and a cycle around
 * a module-level function is how one side ends up holding `undefined` at init. This file imports nothing.
 */

/** Exactly the columns the predicate reads. */
export type DealBidBoardLinkageFields = {
  bidBoardDetachedAt: Date | string | null;
  isBidBoardOwned: boolean | null;
  procoreBidId: number | string | null;
  synchubBidBoardId: string | null;
  bidBoardProjectNumber: string | null;
  bidBoardLinkedAt: Date | string | null;
  readOnlySyncedAt: Date | string | null;
  /**
   * Part of the COMPOSITE identity the export matcher's third tier resolves on (name +
   * bid_board_created_at, for a deal with no bid_board_project_number). A deal carrying only this still
   * gets reclaimed by the next export, so it is linked for every purpose this predicate serves.
   */
  bidBoardCreatedAt: Date | string | null;
};

/**
 * Detached wins over everything; otherwise any live ownership, mirror or identity signal counts.
 *
 * The identity columns count precisely BECAUSE the detach preserves them — they are what the operator
 * follows to the Bid Board project, so they are also what makes the disconnection worth recording. An
 * already-detached deal returns false: the move-back is still allowed (it re-runs the reset), but it is
 * not severing a live link.
 *
 * Every field is REQUIRED. Optional ones would let a narrow projection omit a column and read as "not
 * linked" with no type error — the quiet way this answer turns wrong.
 */
export function isDealBidBoardLinked(deal: DealBidBoardLinkageFields): boolean {
  if (deal.bidBoardDetachedAt != null) return false;
  return Boolean(
    deal.isBidBoardOwned ||
      deal.procoreBidId != null ||
      deal.synchubBidBoardId != null ||
      deal.bidBoardProjectNumber != null ||
      deal.bidBoardLinkedAt != null ||
      deal.readOnlySyncedAt != null ||
      // The composite matcher identity. Without it a deal whose only remaining footprint is
      // bid_board_created_at read as UNLINKED: at Opportunity the eligibility check then called the move
      // a no-op and refused to detach it, while the next export could still match it by name + date and
      // reclaim it; from any other stage the detach ran but suppressed the "delete this project"
      // warning. See bid-board-sync/service.ts's third tier.
      deal.bidBoardCreatedAt != null
  );
}
