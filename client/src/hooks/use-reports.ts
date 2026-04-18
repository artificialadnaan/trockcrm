import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";

export interface SavedReport {
  id: string;
  name: string;
  entity: string;
  config: any;
  isLocked: boolean;
  isDefault: boolean;
  createdBy: string | null;
  officeId: string | null;
  visibility: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReportConfig {
  entity: "deals" | "contacts" | "activities" | "tasks";
  filters: Array<{
    field: string;
    op: string;
    value?: any;
  }>;
  columns: string[];
  sort?: { field: string; dir: "asc" | "desc" };
  chart_type?: "table" | "bar" | "pie" | "line";
  // Locked report specific
  reportType?: string;
  includeDd?: boolean;
}

export interface AnalyticsQueryOptions {
  from?: string;
  to?: string;
  officeId?: string;
  regionId?: string;
  repId?: string;
  source?: string;
  includeDd?: boolean;
}

export interface UnifiedLeadPipelineSummaryRow {
  workflowRoute: "estimating" | "service";
  validationStatus: string;
  intakeCount: number;
}

export interface UnifiedRouteRollupRow {
  workflowRoute: "estimating" | "service";
  dealCount: number;
  totalValue: number;
  staleDealCount: number;
}

export interface UnifiedCompanyRollupRow {
  companyId: string | null;
  companyName: string;
  leadCount: number;
  propertyCount: number;
  dealCount: number;
  activeDealCount: number;
  standardDealCount: number;
  serviceDealCount: number;
  totalValue: number;
}

export interface UnifiedRepActivitySplitRow {
  repId: string;
  repName: string;
  leadStageCalls: number;
  leadStageEmails: number;
  leadStageMeetings: number;
  leadStageNotes: number;
  dealStageCalls: number;
  dealStageEmails: number;
  dealStageMeetings: number;
  dealStageNotes: number;
  totalLeadStageActivities: number;
  totalDealStageActivities: number;
}

export interface UnifiedStaleLeadRow {
  leadId: string;
  leadName: string;
  companyName: string;
  workflowRoute: "estimating" | "service";
  validationStatus: string;
  ageInDays: number;
  staleThresholdDays: number;
}

export interface UnifiedStaleDealRow {
  dealId: string;
  dealNumber: string;
  dealName: string;
  stageName: string;
  workflowRoute: "estimating" | "service";
  repName: string;
  daysInStage: number;
  staleThresholdDays: number;
  dealValue: number;
}

export interface UnifiedWorkflowOverview {
  leadPipelineSummary: UnifiedLeadPipelineSummaryRow[];
  standardVsServiceRollups: UnifiedRouteRollupRow[];
  companyRollups: UnifiedCompanyRollupRow[];
  repActivitySplit: UnifiedRepActivitySplitRow[];
  staleLeads: UnifiedStaleLeadRow[];
  staleDeals: UnifiedStaleDealRow[];
}

export function useSavedReports() {
  const [reports, setReports] = useState<SavedReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchReports = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ reports: SavedReport[] }>("/reports/saved");
      setReports(data.reports);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load reports");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  return { reports, loading, error, refetch: fetchReports };
}

export async function createSavedReport(input: {
  name: string;
  entity: string;
  config: ReportConfig;
  visibility?: string;
}) {
  return api<{ report: SavedReport }>("/reports/saved", {
    method: "POST",
    json: input,
  });
}

export async function updateSavedReport(reportId: string, input: Partial<SavedReport>) {
  return api<{ report: SavedReport }>(`/reports/saved/${reportId}`, {
    method: "PATCH",
    json: input,
  });
}

export async function deleteSavedReport(reportId: string) {
  return api<{ success: boolean }>(`/reports/saved/${reportId}`, {
    method: "DELETE",
  });
}

/** Execute a locked report by its reportType */
function appendAnalyticsQueryOptions(params: URLSearchParams, options: AnalyticsQueryOptions) {
  if (options.from) params.set("from", options.from);
  if (options.to) params.set("to", options.to);
  if (options.officeId) params.set("officeId", options.officeId);
  if (options.regionId) params.set("regionId", options.regionId);
  if (options.repId) params.set("repId", options.repId);
  if (options.source) params.set("source", options.source);
  if (options.includeDd) params.set("includeDd", "true");
}

export async function executeLockedReport(reportType: string, options: AnalyticsQueryOptions = {}) {
  const params = new URLSearchParams();
  appendAnalyticsQueryOptions(params, options);
  const qs = params.toString();

  const endpointMap: Record<string, string> = {
    pipeline_summary: "/reports/pipeline-summary",
    workflow_overview: "/reports/workflow-overview",
    weighted_forecast: "/reports/weighted-forecast",
    win_loss_ratio: "/reports/win-loss",
    activity_summary: "/reports/activity-summary",
    stale_deals: "/reports/stale-deals",
    lost_by_reason: "/reports/lost-by-reason",
    revenue_by_project_type: "/reports/revenue-by-type",
    lead_source_roi: "/reports/lead-source-roi",
    closed_won_summary: "/reports/closed-won-summary",
    pipeline_by_rep: "/reports/pipeline-by-rep",
  };

  const endpoint = endpointMap[reportType];
  if (!endpoint) throw new Error(`Unknown report type: ${reportType}`);

  return api<{ data: any }>(`${endpoint}${qs ? `?${qs}` : ""}`);
}

export async function executeWorkflowOverview(options: AnalyticsQueryOptions = {}) {
  const params = new URLSearchParams();
  appendAnalyticsQueryOptions(params, options);
  const qs = params.toString();

  return api<{ data: UnifiedWorkflowOverview }>(`/reports/workflow-overview${qs ? `?${qs}` : ""}`);
}

export function useUnifiedWorkflowOverview(options: AnalyticsQueryOptions = {}) {
  const [data, setData] = useState<UnifiedWorkflowOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await executeWorkflowOverview(options);
      setData(result.data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load workflow overview");
    } finally {
      setLoading(false);
    }
  }, [options.from, options.to, options.officeId, options.regionId, options.repId, options.source, options.includeDd]);

  useEffect(() => {
    fetchOverview();
  }, [fetchOverview]);

  return { data, loading, error, refetch: fetchOverview };
}

/** Execute a custom report config */
export async function executeCustomReport(
  config: ReportConfig,
  pagination: { page: number; limit: number } = { page: 1, limit: 100 }
) {
  return api<{ rows: Record<string, any>[]; total: number }>("/reports/execute", {
    method: "POST",
    json: { config, ...pagination },
  });
}
