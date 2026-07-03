import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { DealDescriptionHistoryEntry } from "@trock-crm/shared/types";

/**
 * A deal's description change-log (newest first). Mirrors the hand-rolled deal sub-resource hook style.
 * `refreshKey` re-fetches when it changes (pass the deal's current description) so the panel reflects an
 * in-place edit immediately, without a remount.
 */
export function useDealDescriptionHistory(dealId: string, refreshKey?: unknown) {
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
    // Clear when switching deals (or after a save via refreshKey) so stale rows never linger while loading.
    setHistory([]);
    void refetch();
  }, [refetch, refreshKey]);

  return { history, loading, error, refetch };
}
