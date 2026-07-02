import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { DealDescriptionHistoryEntry } from "@trock-crm/shared/types";

/** A deal's description change-log (newest first). Mirrors the hand-rolled deal sub-resource hook style. */
export function useDealDescriptionHistory(dealId: string) {
  const [history, setHistory] = useState<DealDescriptionHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ history: DealDescriptionHistoryEntry[] }>(`/deals/${dealId}/description-history`);
      setHistory(data.history);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load description history");
    } finally {
      setLoading(false);
    }
  }, [dealId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { history, loading, error, refetch };
}
