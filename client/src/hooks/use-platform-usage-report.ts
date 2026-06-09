import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

export interface PlatformUsageRow {
  rep: { id: string; displayName: string };
  usage: {
    activeSeconds: number;
    actionCount: number;
    sessionCount: number;
    viewCount?: number;
    firstActiveAt?: string | null;
    breakdown: { activities: Record<string, number>; [k: string]: unknown };
  };
}
export interface PlatformUsageReport {
  grain: "day" | "week";
  dates: string[];
  summary: { activeSeconds: number; actionCount: number; activeReps: number; totalReps: number };
  leaderboard: PlatformUsageRow[];
}

export function usePlatformUsageReport(params: { grain: "day" | "week"; date?: string; rep?: string }) {
  const [data, setData] = useState<PlatformUsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ grain: params.grain });
      if (params.date) qs.set("date", params.date);
      if (params.rep) qs.set("rep", params.rep);
      const result = await api<{ data: PlatformUsageReport }>(`/reports/platform-usage?${qs.toString()}`);
      setData(result.data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load platform usage");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [params.grain, params.date, params.rep]);

  useEffect(() => { void fetchReport(); }, [fetchReport]);
  return { data, loading, error, refetch: fetchReport };
}

/** Format seconds as "Hh Mm"; returns an em-dash for zero/no time. */
export function formatActiveTime(seconds: number): string {
  if (seconds <= 0) return "—";
  const totalMinutes = Math.round(seconds / 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
