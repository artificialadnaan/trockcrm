import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

export type CleanupRecordType = "lead" | "deal";
export type CleanupSeverity = "low" | "medium" | "high";

export interface CleanupQueueRow {
  recordType: CleanupRecordType;
  recordId: string;
  recordName: string;
  companyName: string | null;
  stageName: string | null;
  reasonCode: string;
  severity: CleanupSeverity;
  officeId: string | null;
  officeName: string | null;
  assignedUserId: string | null;
  assignedUserName: string | null;
  generatedAt: string | null;
  evaluatedAt: string | null;
}

export interface CleanupQueueResponse {
  rows: CleanupQueueRow[];
  total: number;
}

const EMPTY_QUEUE: CleanupQueueResponse = {
  rows: [],
  total: 0,
};

function normalizeQueueResponse(data: Partial<CleanupQueueResponse> | null | undefined): CleanupQueueResponse {
  return {
    rows: data?.rows ?? [],
    total: typeof data?.total === "number" ? data.total : data?.rows?.length ?? 0,
  };
}

export function useMyCleanupQueue() {
  const [data, setData] = useState<CleanupQueueResponse>(EMPTY_QUEUE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api<CleanupQueueResponse>("/admin/cleanup/my");
      setData(normalizeQueueResponse(res));
    } catch (err: unknown) {
      setData(EMPTY_QUEUE);
      setError(err instanceof Error ? err.message : "Failed to load cleanup queue");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return {
    rows: data.rows,
    total: data.total,
    loading,
    error,
    refetch: load,
  };
}
