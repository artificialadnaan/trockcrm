import { useCallback, useEffect, useState } from "react";
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
  /** True only while the deal is freshly declined and not yet reviewed (i.e. the actions are live). */
  actionable: boolean;
}

export function useRfpReview(dealId: string | undefined, officeId?: string | null) {
  const [review, setReview] = useState<RfpReviewDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchReview = useCallback(async () => {
    if (!dealId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ review: RfpReviewDetail }>(
        `/deals/${dealId}/rfp-review`,
        getOfficeRequestOptions(officeId)
      );
      setReview(data.review);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load the RFP review");
    } finally {
      setLoading(false);
    }
  }, [dealId, officeId]);

  useEffect(() => {
    fetchReview();
  }, [fetchReview]);

  return { review, loading, error, refetch: fetchReview };
}

/** Approve the override → re-submit the declined RFP to SyncHub for a fresh approval cycle. */
export async function approveRfpOverride(
  dealId: string,
  input: { note?: string | null; officeId?: string | null }
): Promise<{ success: boolean; status: string; jobId: number }> {
  return api<{ success: boolean; status: string; jobId: number }>(
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
