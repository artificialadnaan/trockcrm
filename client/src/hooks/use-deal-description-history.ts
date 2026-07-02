import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { DealDescriptionHistoryEntry } from "@trock-crm/shared/types";

/** A deal's description change-log (newest first). Mirrors the hand-rolled deal sub-resource hook style. */
export function useDealDescriptionHistory(dealId: string) {
  const [history, setHistory] = useState<DealDescriptionHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Monotonic guard: a slower request for a previously-viewed deal must not overwrite the current deal's
  // history when navigating between deals with an in-flight fetch.
  const requestIdRef = useRef(0);

  const refetch = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ history: DealDescriptionHistoryEntry[] }>(`/deals/${dealId}/description-history`);
      if (requestIdRef.current === requestId) setHistory(data.history);
    } catch (e) {
      if (requestIdRef.current === requestId) setError(e instanceof Error ? e.message : "Failed to load description history");
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, [dealId]);

  useEffect(() => {
    // Clear when switching deals so the prior deal's history never shows under the new deal while loading.
    setHistory([]);
    void refetch();
  }, [refetch]);

  return { history, loading, error, refetch };
}
