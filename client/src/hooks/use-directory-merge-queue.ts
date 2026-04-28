import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

export interface DirectoryMergeQueueEntry {
  id: string;
  entityType: "company" | "contact";
  entityAId: string;
  entityBId: string;
  confidenceScore: string;
  matchReasons: string[];
  status: string;
  entityA: Record<string, unknown> | null;
  entityB: Record<string, unknown> | null;
}

export function useDirectoryMergeQueue(status = "pending") {
  const [entries, setEntries] = useState<DirectoryMergeQueueEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ entries: DirectoryMergeQueueEntry[] }>(`/admin/directory-merge-queue?status=${status}`);
      setEntries(data.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load directory merge queue");
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { entries, loading, error, refetch };
}

export async function mergeDirectoryQueueEntry(entryId: string, winnerId: string) {
  return api(`/admin/directory-merge-queue/${entryId}/merge`, {
    method: "POST",
    json: { winnerId },
  });
}

export async function dismissDirectoryQueueEntry(entryId: string) {
  return api(`/admin/directory-merge-queue/${entryId}/dismiss`, {
    method: "POST",
    json: {},
  });
}
