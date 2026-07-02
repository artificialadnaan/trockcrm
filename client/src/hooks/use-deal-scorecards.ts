import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { FieldScorecardSummary, FieldScorecardDetail } from "@trock-crm/shared/types";

/** Field Scorecards submitted for a deal (T-Rock Cam), newest first. Mirrors the hand-rolled hook style. */
export function useDealScorecards(dealId: string) {
  const [scorecards, setScorecards] = useState<FieldScorecardSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ scorecards: FieldScorecardSummary[] }>(`/deals/${dealId}/scorecards`);
      setScorecards(data.scorecards);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load scorecards");
    } finally {
      setLoading(false);
    }
  }, [dealId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { scorecards, loading, error, refetch };
}

/** Fetch one scorecard's full detail (items, deficiencies, action items, evidence photos w/ presigned urls). */
export async function fetchDealScorecardDetail(dealId: string, scorecardId: string): Promise<FieldScorecardDetail> {
  const data = await api<{ scorecard: FieldScorecardDetail }>(`/deals/${dealId}/scorecards/${scorecardId}`);
  return data.scorecard;
}

/** Presign + open the scorecard's stored PDF (new tab / download). Throws if it's still generating. */
export async function downloadDealScorecardPdf(dealId: string, scorecardId: string): Promise<void> {
  const { url } = await api<{ url: string }>(`/deals/${dealId}/scorecards/${scorecardId}/download`);
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
