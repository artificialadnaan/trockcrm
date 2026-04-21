import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

export interface OwnershipSyncSummary {
  assigned: number;
  unchanged: number;
  unmatched: number;
  conflicts: number;
  inactiveUserConflicts: number;
  examples: {
    matched: Array<{
      recordType: "lead" | "deal";
      recordId: string;
      ownerId: string;
      ownerEmail: string | null;
      assignedRepId: string | null;
      mappingStatus: string;
      reasonCode: string | null;
    }>;
    unmatched: Array<{
      recordType: "lead" | "deal";
      recordId: string;
      ownerId: string;
      ownerEmail: string | null;
      assignedRepId: string | null;
      mappingStatus: string;
      reasonCode: string | null;
    }>;
    conflicts: Array<{
      id: string;
      name?: string;
      recordType?: "lead" | "deal";
      recordId?: string;
      ownerId?: string;
      ownerEmail?: string | null;
      assignedRepId?: string | null;
      mappingStatus?: string;
      reasonCode?: string | null;
    }>;
    inactiveUserConflicts: Array<{
      recordType: "lead" | "deal";
      recordId: string;
      ownerId: string;
      ownerEmail: string | null;
      assignedRepId: string | null;
      mappingStatus: string;
      reasonCode: string | null;
    }>;
  };
}

export interface AssignableUser {
  id: string;
  displayName: string;
  email: string;
  officeId: string;
  isActive: boolean;
}

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

export function previewOwnershipSync() {
  return api<OwnershipSyncSummary>("/admin/ownership-sync/dry-run", {
    method: "POST",
  });
}

export function applyOwnershipSync() {
  return api<OwnershipSyncSummary>("/admin/ownership-sync/apply", {
    method: "POST",
  });
}

export async function listAssignableUsers() {
  const response = await api<{ users: AssignableUser[] }>("/sales-review/assignable-users");
  return response.users;
}

export function reassignOwnership(dealId: string, userId: string) {
  return api<{ success: true }>("/sales-review/ownership-reassign", {
    method: "POST",
    json: { dealId, userId },
  });
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
