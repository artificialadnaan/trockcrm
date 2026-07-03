import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";
import { resolveDatePreset } from "@/lib/pipeline-terminal-filters";
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
  // Wave 1 (P0-1): canonical per-rep Won (same won_closed_date basis as the Closed
  // card). SUM over repCards === the Closed card, replacing the stale snapshot.
  closedValue: number;
  winsCount: number;
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
    floorMet: boolean;
    heldEarnedCommission: number;
    activeDeals: number;
    pipelineValue: number;
    wonUnsignedValue: number;
    wonUnsignedCount: number;
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
  // Deal-VALUE totals counted once per deal (not the inflated sum of involvement rows).
  officeTotals: { activeDeals: number; pipelineValue: number; wonUnsignedValue: number; wonUnsignedCount: number };
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
    qualifyingRevenue: number;
    floorMet: boolean;
  };
  commissionDeals: Array<{
    dealId: string;
    dealNumber: string | null;
    dealName: string;
    companyName: string | null;
    propertyName: string | null;
    paidRevenue: number;
    commissionableMargin: number;
    earnedCommission: number;
    paymentCount: number;
    lastPaidAt: string | null;
    attributionRole: "owner" | "estimator" | "sales_source";
  }>;
  wonMissingContractDate: Array<{
    dealId: string;
    dealNumber: string | null;
    dealName: string;
    companyName: string | null;
    propertyName: string | null;
    value: number;
    wonDate: string | null;
  }>;
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

/**
 * Convert a preset to from/to date strings. Delegates to the CANONICAL platform-wide resolver
 * (resolveDatePreset) so the director/rep dashboards share one window math with the deals
 * list / kanban FilterBar and the period tabs. "custom" has no canonical window here, so it keeps
 * the prior ytd fallback. NOTE: this now resolves on the user's LOCAL calendar (was UTC) — the
 * intended consolidation; it shifts every presetToDateRange consumer (incl. director rep-detail,
 * RED's P2 surface, via this shared hook) from UTC to local month/quarter/year boundaries.
 */
export function presetToDateRange(preset: DateRangePreset): { from: string; to: string } {
  return resolveDatePreset(preset === "custom" ? "ytd" : preset);
}

const ZERO_SCOPE_SUMMARY = { count: 0, totalValue: 0 } as const;
const EMPTY_DD_VS_PIPELINE = {
  ddValue: 0,
  ddCount: 0,
  pipelineValue: 0,
  pipelineCount: 0,
  totalValue: 0,
  totalCount: 0,
} as const;

/**
 * Deep-default the director payload so a null/omitted API field renders 0 / "--" instead of $NaN, and
 * never crashes a `.reduce`/`.map`/`.length` (mirrors the rep dashboard's normalizeRepDashboardData).
 * Currency/count aggregates default to 0; every list defaults to []. The director hook stored res.data
 * raw before — the rep hook already normalized, so a partial director payload rendered $NaN.
 */
export function normalizeDirectorDashboardData(
  raw: Partial<DirectorDashboardData> | null | undefined
): DirectorDashboardData {
  const d = raw ?? {};
  return {
    ...(d as DirectorDashboardData),
    officeFunnelBuckets: d.officeFunnelBuckets ?? [],
    repFunnelRows: d.repFunnelRows ?? [],
    repCommissionRows: d.repCommissionRows ?? [],
    repCards: d.repCards ?? [],
    pipelineByStage: d.pipelineByStage ?? [],
    winRateTrend: d.winRateTrend ?? [],
    activityByRep: d.activityByRep ?? [],
    staleDeals: d.staleDeals ?? [],
    staleLeads: d.staleLeads ?? [],
    crmOwnedProgression: d.crmOwnedProgression ?? [],
    downstreamBottlenecks: d.downstreamBottlenecks ?? [],
    atRiskDeals: d.atRiskDeals ?? [],
    activityPulse: d.activityPulse ?? [],
    strategicAlerts: d.strategicAlerts ?? [],
    aiCoachingPrompts: d.aiCoachingPrompts ?? [],
    recentCloses: d.recentCloses ?? [],
    ddVsPipeline: { ...EMPTY_DD_VS_PIPELINE, ...d.ddVsPipeline },
    scopeSummary: {
      activePipeline: { ...ZERO_SCOPE_SUMMARY, ...d.scopeSummary?.activePipeline },
      won: { ...ZERO_SCOPE_SUMMARY, ...d.scopeSummary?.won },
      atRisk: { ...ZERO_SCOPE_SUMMARY, ...d.scopeSummary?.atRisk },
    },
  };
}

export function useDirectorDashboard(
  dateRange?: { from: string; to: string },
  periodKind?: RepPerformancePeriodKind,
  scope?: "mine" | "team" | "all"
) {
  const [data, setData] = useState<DirectorDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (scope === "team") {
      setData(null);
      setError(null);
      setLoading(false);
      setLastFetchedAt(null);
      return;
    }

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
      setData(normalizeDirectorDashboardData(res.data));
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

// ── Team Commissions drill-down evidence (mirrors server CommissionEvidence) ──

export type CommissionEvidenceMetric =
  | "active" | "pipeline" | "potential" | "won_unsigned" | "estimating" | "earned"
  | "leads" | "qualified" | "opportunities" | "calls" | "emails" | "meetings";

export interface CommissionEvidenceRecord {
  id: string;
  navKind: "deal" | "lead" | null;
  navId: string | null;
  primary: string | null;
  name: string;
  stageLabel: string;
  value: number | null;
  date: string | null;
  companyName: string | null;
}

export interface CommissionEvidence {
  metric: CommissionEvidenceMetric;
  kind: "deal" | "lead" | "activity";
  repId: string;
  repName: string;
  title: string;
  subtitle: string;
  valueLabel: string | null;
  total: { count: number; value: number | null };
  records: CommissionEvidenceRecord[];
}

export interface CommissionDrillRequest {
  repId: string;
  repName: string;
  metric: CommissionEvidenceMetric;
  from?: string;
  to?: string;
}

/** Fetches the supporting records behind one rep's number in one Team Commissions column. */
export function useCommissionEvidence(request: CommissionDrillRequest | null) {
  const [data, setData] = useState<CommissionEvidence | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!request) {
      setData(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    const params = new URLSearchParams({ repId: request.repId, metric: request.metric });
    if (request.from) params.set("from", request.from);
    if (request.to) params.set("to", request.to);
    api<{ data: CommissionEvidence }>(`/dashboard/director/commissions/evidence?${params.toString()}`)
      .then((res) => { if (!cancelled) setData(res.data); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load records"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [request?.repId, request?.metric, request?.from, request?.to]);

  return { data, loading, error };
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
