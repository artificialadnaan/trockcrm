import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";

export interface PeriodMetrics {
  dealsWon: number;
  dealsLost: number;
  totalWonValue: number;
  activitiesLogged: number;
  winRate: number;
  avgDaysToClose: number;
}

export interface PeriodChange {
  dealsWon: number;
  dealsLost: number;
  totalWonValue: number;
  activitiesLogged: number;
  winRate: number;
  avgDaysToClose: number;
}

export interface RepPerformanceData {
  reps: Array<{
    repId: string;
    repName: string;
    current: PeriodMetrics;
    previous: PeriodMetrics;
    change: PeriodChange;
  }>;
  periodLabel: { current: string; previous: string };
}

export function useRepPerformance(period: "month" | "quarter" | "year") {
  const [data, setData] = useState<RepPerformanceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api<RepPerformanceData>(
        `/reports/rep-performance?period=${period}`
      );
      setData(res);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load performance data");
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, error, refetch: fetchData };
}
