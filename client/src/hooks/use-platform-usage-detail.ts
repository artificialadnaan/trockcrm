import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

export type ActionDetailType = "create" | "edit" | "stage_move" | "upload" | "note";

export interface ActionDetailItem {
  type: ActionDetailType;
  label: string;
  entityType: string | null;
  at: string;
}

export interface ViewDetailItem {
  at: string;
  entity_type: string;
  entity_id: string | null;
  route: string;
  label_snapshot: string | null;
}

export interface PlatformUsageDetail {
  rep: { id: string; displayName: string };
  grain: "day" | "week";
  dates: string[];
  actions: { breakdown: Record<ActionDetailType, number>; items: ActionDetailItem[]; truncated: boolean };
  views: { expired: boolean; message?: string; items: ViewDetailItem[] };
}

export function usePlatformUsageDetail(params: { repId: string; grain: "day" | "week"; date?: string }) {
  const [data, setData] = useState<PlatformUsageDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const latestRequestId = useRef(0);

  const fetchDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    const requestId = ++latestRequestId.current;
    try {
      const qs = new URLSearchParams({ grain: params.grain, rep: params.repId });
      if (params.date) qs.set("date", params.date);
      const result = await api<{ data: PlatformUsageDetail }>(`/reports/platform-usage/detail?${qs.toString()}`);
      if (requestId !== latestRequestId.current) return;
      setData(result.data);
    } catch (err: unknown) {
      if (requestId !== latestRequestId.current) return;
      setError(err instanceof Error ? err.message : "Failed to load rep detail");
      setData(null);
    } finally {
      if (requestId === latestRequestId.current) setLoading(false);
    }
  }, [params.repId, params.grain, params.date]);

  useEffect(() => {
    void fetchDetail();
  }, [fetchDetail]);

  return { data, loading, error, refetch: fetchDetail };
}
