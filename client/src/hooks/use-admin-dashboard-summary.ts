import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useAiActionQueue, useSalesProcessDisconnectDashboard } from "@/hooks/use-ai-ops";
import { useAdminInterventions } from "@/hooks/use-admin-interventions";
import { useMigrationExceptions } from "@/hooks/use-migration";
import { useDuplicateQueue } from "@/hooks/use-duplicate-queue";
import { useDirectorDashboard, presetToDateRange } from "@/hooks/use-director-dashboard";
import { buildAdminDashboardSummary } from "@/lib/admin-dashboard-summary";

interface AdminAuditResponse {
  rows: Array<{ createdAt: string }>;
  total: number;
}

interface ProcoreSyncStatusResponse {
  summary: { conflict: number; error: number };
  circuit_breaker: { state: "closed" | "open" | "half_open" };
}

export function useAdminDashboardSummary() {
  const { queue: aiQueue, loading: aiLoading } = useAiActionQueue(50);
  const { data: interventions, loading: interventionLoading } = useAdminInterventions({
    page: 1,
    pageSize: 1,
    status: "open",
    view: "open",
    clusterKey: null,
  });
  const { exceptions, loading: migrationLoading } = useMigrationExceptions();
  const { pagination, loading: mergeLoading } = useDuplicateQueue("pending");
  const { dashboard: disconnectDashboard, loading: disconnectLoading } = useSalesProcessDisconnectDashboard(10);
  const { data: directorData, loading: directorLoading } = useDirectorDashboard(presetToDateRange("ytd"));
  const [auditChangeCount24h, setAuditChangeCount24h] = useState(0);
  const [unhealthySources, setUnhealthySources] = useState<string[]>([]);
  const [procoreIssueCount, setProcoreIssueCount] = useState(0);
  const [extraLoading, setExtraLoading] = useState(true);

  const loadOperationalSignals = useCallback(async () => {
    setExtraLoading(true);
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const fromDate = twentyFourHoursAgo.toISOString().slice(0, 10);

    try {
      const [auditResponse, procoreResponse] = await Promise.all([
        api<AdminAuditResponse>(`/admin/audit?page=1&limit=200&fromDate=${fromDate}`),
        api<ProcoreSyncStatusResponse>("/procore/sync-status"),
      ]);

      setAuditChangeCount24h(
        auditResponse.rows.filter(
          (row) => new Date(row.createdAt).getTime() >= twentyFourHoursAgo.getTime()
        ).length
      );

      const nextUnhealthySources: string[] = [];
      const nextProcoreIssueCount =
        procoreResponse.summary.conflict +
        procoreResponse.summary.error +
        (procoreResponse.circuit_breaker.state === "closed" ? 0 : 1);

      if (nextProcoreIssueCount > 0) {
        nextUnhealthySources.push("procore");
      }

      setProcoreIssueCount(nextProcoreIssueCount);
      setUnhealthySources(nextUnhealthySources);
    } catch {
      setAuditChangeCount24h(0);
      setProcoreIssueCount(0);
      setUnhealthySources([]);
    } finally {
      setExtraLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOperationalSignals();
  }, [loadOperationalSignals]);

  const summary = useMemo(() => {
    const combinedUnhealthySources = unhealthySources.slice();
    if ((exceptions ?? []).some((group) => group.count > 0)) {
      combinedUnhealthySources.push("migration");
    }

    return buildAdminDashboardSummary({
      aiActionCount: aiQueue.length,
      openInterventionCount: interventions?.totalCount ?? 0,
      mergeQueueCount: pagination.total,
      disconnectCount: disconnectDashboard?.summary.totalDisconnects ?? 0,
      migrationExceptionCount: exceptions.reduce((sum, group) => sum + group.count, 0),
      procoreIssueCount,
      unhealthySources: combinedUnhealthySources,
      auditChangeCount24h,
      pipelineValue: directorData?.ddVsPipeline.totalValue ?? 0,
      activeDealCount: directorData?.ddVsPipeline.totalCount ?? 0,
    });
  }, [
    aiQueue.length,
    auditChangeCount24h,
    directorData,
    disconnectDashboard?.summary.totalDisconnects,
    exceptions,
    interventions?.totalCount,
    pagination.total,
    procoreIssueCount,
    unhealthySources,
  ]);

  return {
    summary,
    loading:
      aiLoading ||
      interventionLoading ||
      migrationLoading ||
      mergeLoading ||
      disconnectLoading ||
      directorLoading ||
      extraLoading,
  };
}
