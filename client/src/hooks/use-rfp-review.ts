import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { getOfficeRequestOptions } from "@/lib/office-selection";

export interface RfpReviewDetail {
  dealId: string;
  dealName: string;
  dealNumber: string | null;
  projectNumber: string | null;
  rfpApprovalStatus: string | null;
  rfpApprovalRequestId: number | null;
  requestedAt: string | null;
  requestedById: string | null;
  requestedByName: string | null;
  requestedByEmail: string | null;
  declinedReason: string | null;
  declinedAt: string | null;
  reviewedAt: string | null;
  reviewedById: string | null;
  reviewedByName: string | null;
  reviewDecision: string | null;
  reviewNote: string | null;
  /** Override-approval delivery state: null | 'approving' (SyncHub creating the project) | 'failed' (retryable). */
  overrideState: string | null;
  overrideError: string | null;
  /** True when a reviewer can act now: declined, not currently approving, and not already a re-confirmed denial. */
  actionable: boolean;
}

export function useRfpReview(dealId: string | undefined, officeId?: string | null) {
  const [review, setReview] = useState<RfpReviewDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The dealId|officeId we currently hold data for. A change is a "target change" (show the loading view, drop
  // the prior deal's data + errors); a same-key refetch is a background poll/Retry that refreshes SILENTLY — so
  // the "approving" panel neither flashes "Loading…" nor gets replaced by a full error view on a transient blip.
  const loadedKeyRef = useRef<string | null>(null);

  const fetchReview = useCallback(async () => {
    if (!dealId) {
      setLoading(false);
      return;
    }
    const key = `${dealId}|${officeId ?? ""}`;
    const isTargetChange = loadedKeyRef.current !== key;
    if (isTargetChange) {
      setLoading(true);
      setReview(null);
      setError(null);
    }
    try {
      const data = await api<{ review: RfpReviewDetail }>(
        `/deals/${dealId}/rfp-review`,
        getOfficeRequestOptions(officeId)
      );
      setReview(data.review);
      setError(null);
      loadedKeyRef.current = key;
    } catch (err: unknown) {
      // Only a target-change (initial load) surfaces as a page error; a background poll failure keeps the
      // last-good review + progress panel and lets the next poll retry.
      if (isTargetChange) setError(err instanceof Error ? err.message : "Failed to load the RFP review");
    } finally {
      if (isTargetChange) setLoading(false);
    }
  }, [dealId, officeId]);

  // Optimistically patch the in-memory review so an action's result (e.g. entering 'approving') takes effect
  // immediately — and survives even if the follow-up authoritative refetch fails transiently.
  const applyOptimistic = useCallback((patch: Partial<RfpReviewDetail>) => {
    setReview((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  useEffect(() => {
    fetchReview();
  }, [fetchReview]);

  return { review, loading, error, refetch: fetchReview, applyOptimistic };
}

/**
 * Approve the override → ask SyncHub to authoritatively approve the declined RFP (creates the Bid Board project
 * via Playwright). Returns once SyncHub has accepted the request; the deal flips to approved/estimating when the
 * bid-board-created callback lands (poll the review detail while overrideState === 'approving').
 */
export async function approveRfpOverride(
  dealId: string,
  input: { note?: string | null; officeId?: string | null }
): Promise<{ success: boolean; status: string; requestId: number }> {
  return api<{ success: boolean; status: string; requestId: number }>(
    `/deals/${dealId}/rfp-override/approve`,
    { method: "POST", json: { note: input.note ?? null }, ...getOfficeRequestOptions(input.officeId) }
  );
}

/** Re-confirm the denial → the RFP stays declined and is marked reviewed so it is not re-flagged. */
export async function reconfirmRfpDecline(
  dealId: string,
  input: { note?: string | null; officeId?: string | null }
): Promise<{ success: boolean; status: string; decision: string }> {
  return api<{ success: boolean; status: string; decision: string }>(
    `/deals/${dealId}/rfp-override/reconfirm-decline`,
    { method: "POST", json: { note: input.note ?? null }, ...getOfficeRequestOptions(input.officeId) }
  );
}
