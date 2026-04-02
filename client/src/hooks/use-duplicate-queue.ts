import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";
import type { Contact } from "./use-contacts";

export interface DuplicateQueueEntry {
  id: string;
  contactAId: string;
  contactBId: string;
  matchType: string;
  confidenceScore: string;
  status: string;
  resolvedBy: string | null;
  createdAt: string;
  resolvedAt: string | null;
  contactA: Contact | null;
  contactB: Contact | null;
}

export function useDuplicateQueue(status = "pending") {
  const [entries, setEntries] = useState<DuplicateQueueEntry[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 20, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchQueue = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{
        entries: DuplicateQueueEntry[];
        pagination: { page: number; limit: number; total: number; totalPages: number };
      }>(`/contacts/duplicates?status=${status}`);
      setEntries(data.entries);
      setPagination(data.pagination);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load duplicate queue");
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    fetchQueue();
  }, [fetchQueue]);

  return { entries, pagination, loading, error, refetch: fetchQueue };
}

export async function mergeDuplicate(queueEntryId: string, winnerId: string, loserId: string) {
  return api<{ merge: { winnerId: string; loserId: string; fieldsAbsorbed: string[]; associationsMoved: number } }>(`/contacts/duplicates/${queueEntryId}/merge`, {
    method: "POST",
    json: { winnerId, loserId },
  });
}

export async function dismissDuplicate(queueEntryId: string) {
  return api<{ entry: DuplicateQueueEntry }>(`/contacts/duplicates/${queueEntryId}/dismiss`, {
    method: "POST",
    json: {},
  });
}
