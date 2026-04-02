import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";

export interface RepDashboardData {
  activeDeals: { count: number; totalValue: number };
  tasksToday: { overdue: number; today: number };
  activityThisWeek: {
    calls: number;
    emails: number;
    meetings: number;
    notes: number;
    total: number;
  };
  followUpCompliance: { total: number; onTime: number; complianceRate: number };
  pipelineByStage: Array<{
    stageId: string;
    stageName: string;
    stageColor: string | null;
    dealCount: number;
    totalValue: number;
  }>;
}

export function useRepDashboard() {
  const [data, setData] = useState<RepDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api<{ data: RepDashboardData }>("/dashboard/rep");
      setData(res.data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load dashboard");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch();
  }, [fetch]);

  return { data, loading, error, refetch: fetch };
}
