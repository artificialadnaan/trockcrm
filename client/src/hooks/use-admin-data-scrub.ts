import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

export interface AdminDataScrubOverviewSummary {
  openDuplicateContacts: number;
  resolvedDuplicateContacts7d: number;
  openOwnershipGaps: number;
  recentScrubActions7d: number;
}

export interface AdminDataScrubBacklogBucket {
  bucketKey: string;
  label: string;
  count: number;
  linkPath: string;
}

export interface AdminOwnershipCoverageRow {
  gapKey: string;
  label: string;
  count: number;
}

export interface AdminScrubActivityRow {
  userId: string | null;
  userName: string;
  actionCount: number;
  ownershipEditCount: number;
  lastActionAt: string | null;
}

export interface AdminDataScrubOverview {
  summary: AdminDataScrubOverviewSummary;
  backlogBuckets: AdminDataScrubBacklogBucket[];
  ownershipCoverage: AdminOwnershipCoverageRow[];
  scrubActivityByUser: AdminScrubActivityRow[];
}

export async function executeAdminDataScrubOverview() {
  return api<AdminDataScrubOverview>("/admin/data-scrub/overview");
}

export function useAdminDataScrub() {
  const [data, setData] = useState<AdminDataScrubOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await executeAdminDataScrubOverview();
      setData(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load admin data scrub overview");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, loading, error, refetch: load };
}
