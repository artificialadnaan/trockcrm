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
export async function executeLockedReport(
  reportType: string,
  options: { from?: string; to?: string; repId?: string; includeDd?: boolean } = {}
) {
  const params = new URLSearchParams();
  if (options.from) params.set("from", options.from);
  if (options.to) params.set("to", options.to);
  if (options.repId) params.set("repId", options.repId);
  if (options.includeDd) params.set("includeDd", "true");
  const qs = params.toString();

  const endpointMap: Record<string, string> = {
    pipeline_summary: "/reports/pipeline-summary",
    weighted_forecast: "/reports/weighted-forecast",
    win_loss_ratio: "/reports/win-loss",
    activity_summary: "/reports/activity-summary",
    stale_deals: "/reports/stale-deals",
    lost_by_reason: "/reports/lost-by-reason",
    revenue_by_project_type: "/reports/revenue-by-type",
    lead_source_roi: "/reports/lead-source-roi",
  };

  const endpoint = endpointMap[reportType];
  if (!endpoint) throw new Error(`Unknown report type: ${reportType}`);

  return api<{ data: any }>(`${endpoint}${qs ? `?${qs}` : ""}`);
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
