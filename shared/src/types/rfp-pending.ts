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
    !deal.isBidBoardOwned &&
    pendingRfpSubStateForStatus(deal.rfpApprovalStatus) !== null
  );
}
