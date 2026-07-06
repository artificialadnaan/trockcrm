/**
 * How long after an RFP request was made the deal-detail page keeps 5s-polling for it to resolve. A genuinely
 * in-flight RFP (just triggered → pending_outbox → SyncHub, or a freshly-opened vote round) flips to its resolved
 * state within minutes; a deal stuck `pending` for hours/days (a legacy or failed request) must NOT refresh the page
 * every 5s forever — especially while RFP voting is disabled and such deals can never resolve.
 */
export const RFP_DETAIL_POLL_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

/**
 * True while the deal-detail page should keep polling for an in-flight RFP to resolve. Gated on BOTH the pending
 * status AND the request being RECENT (within the window), so a request stuck `pending` indefinitely stops the poll
 * instead of refreshing forever. Pure + time-injected so it's the same check at effect-setup and on each tick.
 */
export function isRfpDetailPollActive(
  rfpApprovalStatus: string | null | undefined,
  rfpApprovalRequestedAt: string | null | undefined,
  nowMs: number,
): boolean {
  if (rfpApprovalStatus !== "pending" && rfpApprovalStatus !== "pending_outbox") return false;
  if (!rfpApprovalRequestedAt) return false;
  const requestedMs = new Date(rfpApprovalRequestedAt).getTime();
  if (!Number.isFinite(requestedMs)) return false;
  return nowMs - requestedMs <= RFP_DETAIL_POLL_WINDOW_MS;
}
