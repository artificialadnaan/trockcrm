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
  const [auditChangeCount24h, setAuditChangeCount24h] = useState<number | null>(0);
  const [unhealthySources, setUnhealthySources] = useState<string[]>([]);
  const [unavailableSources, setUnavailableSources] = useState<string[]>([]);
  const [procoreIssueCount, setProcoreIssueCount] = useState<number | null>(0);
  const [extraLoading, setExtraLoading] = useState(true);

  const loadOperationalSignals = useCallback(async () => {
    setExtraLoading(true);
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const fromDate = twentyFourHoursAgo.toISOString();

    try {
      const [auditResult, procoreResult] = await Promise.allSettled([
        api<AdminAuditResponse>(`/admin/audit?page=1&limit=200&fromDate=${fromDate}`),
        api<ProcoreSyncStatusResponse>("/procore/sync-status"),
      ]);

      const nextUnhealthySources: string[] = [];
      const nextUnavailableSources: string[] = [];
      const nextAuditChangeCount24h =
        auditResult.status === "fulfilled" ? auditResult.value.total : null;
      let nextProcoreIssueCount: number | null = null;

      if (auditResult.status !== "fulfilled") {
        nextUnavailableSources.push("audit");
      }

      if (procoreResult.status === "fulfilled") {
        nextProcoreIssueCount =
          procoreResult.value.summary.conflict +
          procoreResult.value.summary.error +
          (procoreResult.value.circuit_breaker.state === "closed" ? 0 : 1);
        if (nextProcoreIssueCount > 0) {
          nextUnhealthySources.push("procore");
        }
      } else {
        nextUnavailableSources.push("procore");
      }

      setAuditChangeCount24h(nextAuditChangeCount24h);
      setProcoreIssueCount(nextProcoreIssueCount);
      setUnhealthySources(nextUnhealthySources);
      setUnavailableSources(nextUnavailableSources);
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
      unavailableSources,
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
    unavailableSources,
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
