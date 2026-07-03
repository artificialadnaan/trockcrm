import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { getOfficeRequestOptions } from "@/lib/office-selection";
import type { DealDetail } from "@/hooks/use-deals";

export interface RfpVoteDeal {
  id: string;
  name: string;
  projectNumber: string | null;
  rfpApprovalStatus: string | null;
  rfpVotes: DealDetail["rfpVotes"];
  rfpVoteState: DealDetail["rfpVoteState"];
}

/**
 * Loads a deal's vote detail (reusing the deal detail payload, which carries rfpVotes + rfpVoteState) and casts a
 * vote. Mirrors use-rfp-review: target-change vs silent-poll refetch, gated to voters by the caller (dealId is
 * passed undefined for non-voters so no request fires).
 */
export function useRfpVote(dealId: string | undefined, officeId?: string | null) {
  const [deal, setDeal] = useState<RfpVoteDeal | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadedKeyRef = useRef<string | null>(null);
  // Monotonic marker for the latest in-flight request (finding Z1). Only the most recent invocation may commit
  // setDeal/setError/setLoading — otherwise a slower earlier request (e.g. after a fast dealId/officeId change)
  // can resolve last and overwrite newer state.
  const requestIdRef = useRef(0);

  const fetchDeal = useCallback(async () => {
    if (!dealId) {
      setLoading(false);
      return;
    }
    const key = `${dealId}|${officeId ?? ""}`;
    const myRequest = ++requestIdRef.current;
    const isTargetChange = loadedKeyRef.current !== key;
    if (isTargetChange) {
      setLoading(true);
      setDeal(null);
      setError(null);
    }
    try {
      const data = await api<{ deal: DealDetail }>(`/deals/${dealId}/detail`, getOfficeRequestOptions(officeId));
      if (requestIdRef.current !== myRequest) return; // superseded by a newer request
      setDeal({
        id: data.deal.id,
        name: data.deal.name,
        projectNumber: data.deal.projectNumber ?? null,
        rfpApprovalStatus: data.deal.rfpApprovalStatus ?? null,
        rfpVotes: data.deal.rfpVotes,
        rfpVoteState: data.deal.rfpVoteState,
      });
      setError(null);
      loadedKeyRef.current = key;
    } catch (err: unknown) {
      if (requestIdRef.current !== myRequest) return; // superseded — don't clobber newer state with a stale error
      if (isTargetChange) setError(err instanceof Error ? err.message : "Failed to load the RFP vote");
    } finally {
      if (requestIdRef.current === myRequest && isTargetChange) setLoading(false);
    }
  }, [dealId, officeId]);

  useEffect(() => {
    fetchDeal();
  }, [fetchDeal]);

  return { deal, loading, error, refetch: fetchDeal };
}

/** Cast a vote. Reject requires a non-empty reason (the server also enforces this: 400 RFP_VOTE_REASON_REQUIRED). */
export async function castRfpVote(
  dealId: string,
  input: { decision: "approve" | "reject"; reason?: string | null; officeId?: string | null }
): Promise<{ outcome: "pending" | "approved" | "rejected"; votes: unknown[] }> {
  return api<{ outcome: "pending" | "approved" | "rejected"; votes: unknown[] }>(`/deals/${dealId}/rfp-vote`, {
    method: "POST",
    json: input.decision === "reject" ? { decision: "reject", reason: input.reason ?? "" } : { decision: "approve" },
    ...getOfficeRequestOptions(input.officeId),
  });
}
