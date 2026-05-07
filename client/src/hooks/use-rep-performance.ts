import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";

export type RepPerformancePeriodKind =
  | "mtd"
  | "qtd"
  | "ytd"
  | "last_month"
  | "last_quarter"
  | "last_year"
  | "week_8back";

export type LegacyRepPerformancePeriod = "month" | "quarter" | "year";

export interface ForecastVsGoal {
  forecast: number;
  goal: number | null;
  goalSource: "none" | "manual" | "calculated";
  percentToGoal: number | null;
}

export interface RepPerformanceSnapshotRow {
  repId: string;
  repName: string;
  periodKind: RepPerformancePeriodKind;
  periodStart: string;
  periodEnd: string;
  pipelineValue: number;
  closedValue: number;
  dealsCount: number;
  winsCount: number;
  lossesCount: number;
  winRate: number;
  atRiskCount: number;
  activityTotal: number;
  calls: number;
  emails: number;
  meetings: number;
  notes: number;
  sparkline8w: number[];
  region: string | null;
  computedAt: string;
  forecast: number;
  goal: number | null;
  goalSource: "none" | "manual" | "calculated";
  percentToGoal: number | null;
  forecastVsGoal: ForecastVsGoal;
  previous: {
    pipelineValue: number;
    closedValue: number;
    dealsCount: number;
    winsCount: number;
    lossesCount: number;
    winRate: number;
    atRiskCount: number;
    activityTotal: number;
    calls: number;
    emails: number;
    meetings: number;
    notes: number;
  } | null;
}

export interface PeriodMetrics {
  dealsWon: number;
  dealsLost: number;
  totalWonValue: number;
  activitiesLogged: number;
  winRate: number;
  avgDaysToClose: number;
}

export interface PeriodChange {
  dealsWon: number | null;
  dealsLost: number | null;
  totalWonValue: number | null;
  activitiesLogged: number | null;
  winRate: number | null;
  avgDaysToClose: number | null;
}

export interface PeriodPercentChange {
  dealsWon: number | null;
  dealsLost: number | null;
  totalWonValue: number | null;
  activitiesLogged: number | null;
  winRate: number | null;
  avgDaysToClose: number | null;
}

export interface RepPerformanceData {
  rows: RepPerformanceSnapshotRow[];
  forecastVsGoal: ForecastVsGoal;
  reps: Array<{
    repId: string;
    repName: string;
    current: PeriodMetrics;
    previous: PeriodMetrics | null;
    change: PeriodChange;
    percentChange: PeriodPercentChange;
  }>;
  periodLabel: { current: string; previous: string };
}

export function normalizeRepPerformancePeriod(
  period: RepPerformancePeriodKind | LegacyRepPerformancePeriod
): RepPerformancePeriodKind {
  if (period === "month") return "mtd";
  if (period === "quarter") return "qtd";
  if (period === "year") return "ytd";
  return period;
}

function labelForPeriod(periodKind: RepPerformancePeriodKind) {
  const labels: Record<RepPerformancePeriodKind, string> = {
    mtd: "Month to date",
    qtd: "Quarter to date",
    ytd: "Year to date",
    last_month: "Last month",
    last_quarter: "Last quarter",
    last_year: "Last year",
    week_8back: "Last 8 weeks",
  };
  return labels[periodKind];
}

function toPeriodMetrics(row: RepPerformanceSnapshotRow): PeriodMetrics {
  return {
    dealsWon: row.winsCount,
    dealsLost: row.lossesCount,
    totalWonValue: row.closedValue,
    activitiesLogged: row.activityTotal,
    winRate: row.winRate,
    avgDaysToClose: 0,
  };
}

function toPreviousPeriodMetrics(row: RepPerformanceSnapshotRow): PeriodMetrics | null {
  if (!row.previous) return null;
  return {
    dealsWon: row.previous.winsCount,
    dealsLost: row.previous.lossesCount,
    totalWonValue: row.previous.closedValue,
    activitiesLogged: row.previous.activityTotal,
    winRate: row.previous.winRate,
    avgDaysToClose: 0,
  };
}

function toChange(current: PeriodMetrics, previous: PeriodMetrics | null): PeriodChange {
  if (!previous) {
    return {
      dealsWon: null,
      dealsLost: null,
      totalWonValue: null,
      activitiesLogged: null,
      winRate: null,
      avgDaysToClose: null,
    };
  }

  return {
    dealsWon: current.dealsWon - previous.dealsWon,
    dealsLost: current.dealsLost - previous.dealsLost,
    totalWonValue: current.totalWonValue - previous.totalWonValue,
    activitiesLogged: current.activitiesLogged - previous.activitiesLogged,
    winRate: current.winRate - previous.winRate,
    avgDaysToClose: current.avgDaysToClose - previous.avgDaysToClose,
  };
}

function percentDelta(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Number((((current - previous) / previous) * 100).toFixed(2));
}

function toPercentChange(current: PeriodMetrics, previous: PeriodMetrics | null): PeriodPercentChange {
  if (!previous) {
    return {
      dealsWon: null,
      dealsLost: null,
      totalWonValue: null,
      activitiesLogged: null,
      winRate: null,
      avgDaysToClose: null,
    };
  }

  return {
    dealsWon: percentDelta(current.dealsWon, previous.dealsWon),
    dealsLost: percentDelta(current.dealsLost, previous.dealsLost),
    totalWonValue: percentDelta(current.totalWonValue, previous.totalWonValue),
    activitiesLogged: percentDelta(current.activitiesLogged, previous.activitiesLogged),
    winRate: percentDelta(current.winRate, previous.winRate),
    avgDaysToClose: percentDelta(current.avgDaysToClose, previous.avgDaysToClose),
  };
}

export async function fetchRepPerformance(
  period: RepPerformancePeriodKind | LegacyRepPerformancePeriod
): Promise<RepPerformanceData> {
  const periodKind = normalizeRepPerformancePeriod(period);
  const response = await api<{ data: { rows: RepPerformanceSnapshotRow[]; forecastVsGoal: ForecastVsGoal } }>(
    `/dashboard/director/rep-performance?periodKind=${periodKind}`
  );
  const rows = response.data.rows;

  return {
    rows,
    forecastVsGoal: response.data.forecastVsGoal,
    reps: rows.map((row) => {
      const current = toPeriodMetrics(row);
      const previous = toPreviousPeriodMetrics(row);

      return {
        repId: row.repId,
        repName: row.repName,
        current,
        previous,
        change: toChange(current, previous),
        percentChange: toPercentChange(current, previous),
      };
    }),
    periodLabel: {
      current: labelForPeriod(periodKind),
      previous: "Baseline pending",
    },
  };
}

export function useRepPerformance(period: RepPerformancePeriodKind | LegacyRepPerformancePeriod = "mtd") {
  const [data, setData] = useState<RepPerformanceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchRepPerformance(period);
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
