import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";

export interface CleanupReasonSummary {
  reasonCode: string;
  count: number;
}

export interface MyCleanupSummary {
  total: number;
  byReason: CleanupReasonSummary[];
}

export interface FunnelBucketSummary {
  key: "lead" | "qualified_lead" | "opportunity" | "due_diligence" | "estimating";
  label: string;
  count: number;
  totalValue: number | null;
  route: "/leads" | "/deals";
  bucket: "lead" | "qualified_lead" | "opportunity" | "due_diligence" | "estimating";
}

export interface RepDashboardData {
  activeLeads: { count: number };
  funnelBuckets: FunnelBucketSummary[];
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
  staleLeads: {
    count: number;
    averageDaysInStage: number | null;
    leads: Array<{
      leadId: string;
      leadName: string;
      companyName: string;
      propertyName: string;
      stageName: string;
      repName: string;
      daysInStage: number;
    }>;
  };
  leadSnapshot: Array<{
    leadId: string;
    leadName: string;
    companyName: string | null;
    propertyName: string | null;
    stageName: string;
    daysInStage: number;
    updatedAt: string;
  }>;
  dealSnapshot: Array<{
    dealId: string;
    dealName: string;
    companyName: string | null;
    propertyName: string | null;
    stageName: string;
    totalValue: number;
    updatedAt: string;
  }>;
  myCleanup: MyCleanupSummary;
}

const DEFAULT_REP_DASHBOARD_DATA: RepDashboardData = {
  activeLeads: { count: 0 },
  funnelBuckets: [],
  commissionSummary: {
    commissionRate: 0,
    overrideRate: 0,
    rollingFloor: 0,
    rollingPaidRevenue: 0,
    rollingCommissionableMargin: 0,
    floorRemaining: 0,
    newCustomerRevenue: 0,
    newCustomerShare: 0,
    newCustomerShareFloor: 0,
    meetsNewCustomerShare: false,
    estimatedPaymentCount: 0,
    excludedLowMarginRevenue: 0,
    directEarnedCommission: 0,
    overrideEarnedCommission: 0,
    totalEarnedCommission: 0,
    potentialRevenue: 0,
    potentialMargin: 0,
    potentialCommission: 0,
  },
  activeDeals: { count: 0, totalValue: 0 },
  tasksToday: { overdue: 0, today: 0 },
  activityThisWeek: { calls: 0, emails: 0, meetings: 0, notes: 0, total: 0 },
  followUpCompliance: { total: 0, onTime: 0, complianceRate: 0 },
  pipelineByStage: [],
  staleLeads: {
    count: 0,
    averageDaysInStage: null,
    leads: [],
  },
  leadSnapshot: [],
  dealSnapshot: [],
  myCleanup: {
    total: 0,
    byReason: [],
  },
};

function normalizeRepDashboardData(data: Partial<RepDashboardData> | null | undefined): RepDashboardData {
  return {
    ...DEFAULT_REP_DASHBOARD_DATA,
    ...(data ?? {}),
    activeLeads: {
      ...DEFAULT_REP_DASHBOARD_DATA.activeLeads,
      ...(data?.activeLeads ?? {}),
    },
    funnelBuckets: data?.funnelBuckets ?? [],
    commissionSummary: {
      ...DEFAULT_REP_DASHBOARD_DATA.commissionSummary,
      ...(data?.commissionSummary ?? {}),
    },
    activeDeals: {
      ...DEFAULT_REP_DASHBOARD_DATA.activeDeals,
      ...(data?.activeDeals ?? {}),
    },
    tasksToday: {
      ...DEFAULT_REP_DASHBOARD_DATA.tasksToday,
      ...(data?.tasksToday ?? {}),
    },
    activityThisWeek: {
      ...DEFAULT_REP_DASHBOARD_DATA.activityThisWeek,
      ...(data?.activityThisWeek ?? {}),
    },
    followUpCompliance: {
      ...DEFAULT_REP_DASHBOARD_DATA.followUpCompliance,
      ...(data?.followUpCompliance ?? {}),
    },
    pipelineByStage: data?.pipelineByStage ?? [],
    staleLeads: {
      ...DEFAULT_REP_DASHBOARD_DATA.staleLeads,
      ...(data?.staleLeads ?? {}),
      leads: data?.staleLeads?.leads ?? [],
    },
    leadSnapshot: data?.leadSnapshot ?? [],
    dealSnapshot: data?.dealSnapshot ?? [],
    myCleanup: {
      ...DEFAULT_REP_DASHBOARD_DATA.myCleanup,
      ...(data?.myCleanup ?? {}),
      byReason: data?.myCleanup?.byReason ?? [],
    },
  };
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
      setData(normalizeRepDashboardData(res.data));
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
