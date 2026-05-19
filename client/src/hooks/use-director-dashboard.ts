import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";
import type { FunnelBucketSummary } from "./use-dashboard";
import type { ForecastVsGoal, RepPerformancePeriodKind } from "./use-rep-performance";

export interface RepPerformanceCard {
  repId: string;
  repName: string;
  activeDeals: number;
  pipelineValue: number;
  winRate: number;
  activityScore: number;
  staleDeals: number;
  staleLeads: number;
}

export interface DirectorDashboardData {
  officeFunnelBuckets: FunnelBucketSummary[];
  repFunnelRows: DirectorRepFunnelRow[];
  repCommissionRows: Array<{
    repId: string;
    repName: string;
    totalEarnedCommission: number;
    potentialCommission: number;
    floorRemaining: number;
    newCustomerShare: number;
    meetsNewCustomerShare: boolean;
  }>;
  repCards: RepPerformanceCard[];
  pipelineByStage: Array<{
    stageId: string;
    stageName: string;
    stageColor: string | null;
    dealCount: number;
    totalValue: number;
  }>;
  winRateTrend: Array<{
    month: string;
    wins: number;
    losses: number;
    winRate: number;
  }>;
  activityByRep: Array<{
    repId: string;
    repName: string;
    calls: number;
    emails: number;
    meetings: number;
    notes: number;
    total: number;
  }>;
  staleDeals: Array<{
    dealId: string;
    dealNumber: string;
    dealName: string;
    stageName: string;
    repName: string;
    daysInStage: number;
    dealValue: number;
    workflowRoute?: "normal" | "service";
    bidBoardStageStatus?: string | null;
    regionClassification?: string | null;
    staleThresholdDays?: number;
  }>;
  staleLeads: Array<{
    leadId: string;
    leadName: string;
    companyName: string;
    propertyName: string;
    stageName: string;
    repName: string;
    daysInStage: number;
    pipelineType?: "normal" | "service";
    locationLabel?: string | null;
    estimatedValue?: number;
    staleThresholdDays?: number;
    daysPastDue?: number;
  }>;
  crmOwnedProgression?: Array<{
    workflowBucket: "lead" | "opportunity";
    workflowRoute: "normal" | "service";
    stageName: string;
    itemCount: number;
    totalValue: number;
  }>;
  downstreamBottlenecks?: Array<{
    dealId: string;
    dealName: string;
    stageName: string;
    mirroredStageStatus: string | null;
    workflowRoute: "normal" | "service";
    regionClassification: string;
    dealValue: number;
    daysInStage: number;
    staleThresholdDays: number;
  }>;
  atRiskDeals?: Array<{
    dealId: string;
    repId: string | null;
    repName: string;
    dealName: string;
    stageName: string;
    mirroredStageStatus: string | null;
    workflowRoute: "normal" | "service";
    regionClassification: string;
    dealValue: number;
    daysInStage: number;
    staleThresholdDays: number;
  }>;
  forecastVsGoal?: ForecastVsGoal;
  activityPulse?: Array<{
    repId: string;
    repName: string;
    calls: number;
    emails: number;
    meetings: number;
    notes: number;
    total: number;
  }>;
  strategicAlerts?: Array<{
    id: string;
    severity: "info" | "warning" | "critical";
    title: string;
    detail: string;
    repId?: string;
  }>;
  aiCoachingPrompts?: Array<{
    id: string;
    repId: string;
    repName: string;
    prompt: string;
    reason: string;
  }>;
  recentCloses?: Array<{
    dealId: string;
    dealNumber: string | null;
    dealName: string;
    repId: string | null;
    repName: string;
    outcome: "won" | "lost";
    dealValue: number;
    closedAt: string;
  }>;
  opportunityVsPipeline?: {
    opportunityValue: number;
    opportunityCount: number;
    pipelineValue: number;
    pipelineCount: number;
    totalValue: number;
    totalCount: number;
  };
  ddVsPipeline: {
    ddValue: number;
    ddCount: number;
    pipelineValue: number;
    pipelineCount: number;
    totalValue: number;
    totalCount: number;
  };
  scopeSummary?: {
    activePipeline: { count: number; totalValue: number };
    won: { count: number; totalValue: number };
    atRisk: { count: number; totalValue: number };
    stale: { count: number; totalValue: number };
  };
}

export interface DirectorRepFunnelRow {
  repId: string;
  repName: string;
  leads: number;
  qualifiedLeads: number;
  opportunities: number;
  estimating: number;
}

export interface DirectorCommissionWorkspaceData {
  rows: Array<{
    repId: string;
    repName: string;
    totalEarnedCommission: number;
    potentialCommission: number;
    floorRemaining: number;
    newCustomerShare: number;
    meetsNewCustomerShare: boolean;
    activeDeals: number;
    pipelineValue: number;
    leads: number;
    qualifiedLeads: number;
    opportunities: number;
    estimating: number;
    calls: number;
    emails: number;
    meetings: number;
    notes: number;
    totalActivities: number;
  }>;
}

export interface RepDetailData {
  activeDeals: { count: number; totalValue: number };
  commissionSummary: {
    commissionRate: number;
    overrideRate: number;
    rollingFloor: number;
    rollingPaidRevenue: number;
    rollingCommissionableMargin: number;
    floorRemaining: number;
    newCustomerRevenue: number;
    newCustomerShare: number;
    newCustomerShareFloor: number;
    meetsNewCustomerShare: boolean;
    estimatedPaymentCount: number;
    excludedLowMarginRevenue: number;
    directEarnedCommission: number;
    overrideEarnedCommission: number;
    totalEarnedCommission: number;
    potentialRevenue: number;
    potentialMargin: number;
    potentialCommission: number;
  };
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
  winLoss: {
    repId: string;
    repName: string;
    wins: number;
    losses: number;
    winRate: number;
    totalValue: number;
  };
  winRateTrend: Array<{ month: string; wins: number; losses: number; winRate: number }>;
  staleDeals: Array<{
    dealId: string;
    dealNumber: string;
    dealName: string;
    stageName: string;
    repName: string;
    daysInStage: number;
    dealValue: number;
  }>;
  staleLeads: Array<{
    leadId: string;
    leadName: string;
    companyName: string;
    propertyName: string;
    stageName: string;
    repName: string;
    daysInStage: number;
    pipelineType?: "normal" | "service";
    locationLabel?: string | null;
    estimatedValue?: number;
    staleThresholdDays?: number;
    daysPastDue?: number;
  }>;
}

export type DateRangePreset = "mtd" | "qtd" | "ytd" | "last_month" | "last_quarter" | "last_year" | "custom";

/** Convert a preset to from/to date strings */
export function presetToDateRange(preset: DateRangePreset): { from: string; to: string } {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-indexed
  const today = now.toISOString().slice(0, 10);

  switch (preset) {
    case "mtd":
      return { from: `${year}-${String(month + 1).padStart(2, "0")}-01`, to: today };
    case "qtd": {
      const qStart = Math.floor(month / 3) * 3;
      return { from: `${year}-${String(qStart + 1).padStart(2, "0")}-01`, to: today };
    }
    case "ytd":
      return { from: `${year}-01-01`, to: today };
    case "last_month": {
      const lm = month === 0 ? 11 : month - 1;
      const lmYear = month === 0 ? year - 1 : year;
      const lastDay = new Date(Date.UTC(lmYear, lm + 1, 0)).getUTCDate();
      return {
        from: `${lmYear}-${String(lm + 1).padStart(2, "0")}-01`,
        to: `${lmYear}-${String(lm + 1).padStart(2, "0")}-${lastDay}`,
      };
    }
    case "last_quarter": {
      const cq = Math.floor(month / 3);
      const lq = cq === 0 ? 3 : cq - 1;
      const lqYear = cq === 0 ? year - 1 : year;
      const lqStart = lq * 3;
      const lqEndMonth = lqStart + 2;
      const lqLastDay = new Date(Date.UTC(lqYear, lqEndMonth + 1, 0)).getUTCDate();
      return {
        from: `${lqYear}-${String(lqStart + 1).padStart(2, "0")}-01`,
        to: `${lqYear}-${String(lqEndMonth + 1).padStart(2, "0")}-${lqLastDay}`,
      };
    }
    case "last_year":
      return { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` };
    default: // custom or ytd fallback
      return { from: `${year}-01-01`, to: today };
  }
}

export function useDirectorDashboard(
  dateRange?: { from: string; to: string },
  periodKind?: RepPerformancePeriodKind,
  scope?: "mine" | "all"
) {
  const [data, setData] = useState<DirectorDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (dateRange?.from) params.set("from", dateRange.from);
      if (dateRange?.to) params.set("to", dateRange.to);
      if (periodKind) params.set("periodKind", periodKind);
      if (scope) params.set("scope", scope);
      const qs = params.toString();
      const res = await api<{ data: DirectorDashboardData }>(
        `/dashboard/director${qs ? `?${qs}` : ""}`
      );
      setData(res.data);
      setLastFetchedAt(new Date().toISOString());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load director dashboard");
    } finally {
      setLoading(false);
    }
  }, [dateRange?.from, dateRange?.to, periodKind, scope]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, error, refetch: fetchData, lastFetchedAt };
}

export function useDirectorCommissionWorkspace(dateRange?: { from: string; to: string }) {
  const [data, setData] = useState<DirectorCommissionWorkspaceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (dateRange?.from) params.set("from", dateRange.from);
      if (dateRange?.to) params.set("to", dateRange.to);
      const qs = params.toString();
      const res = await api<{ data: DirectorCommissionWorkspaceData }>(
        `/dashboard/director/commissions${qs ? `?${qs}` : ""}`
      );
      setData(res.data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load team commissions");
    } finally {
      setLoading(false);
    }
  }, [dateRange?.from, dateRange?.to]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, error, refetch: fetchData };
}

export function useRepDetail(repId: string | undefined, dateRange?: { from: string; to: string }) {
  const [data, setData] = useState<RepDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!repId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (dateRange?.from) params.set("from", dateRange.from);
      if (dateRange?.to) params.set("to", dateRange.to);
      const qs = params.toString();
      const res = await api<{ data: RepDetailData }>(
        `/dashboard/director/rep/${repId}${qs ? `?${qs}` : ""}`
      );
      setData(res.data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load rep detail");
    } finally {
      setLoading(false);
    }
  }, [repId, dateRange?.from, dateRange?.to]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, error, refetch: fetchData };
}
