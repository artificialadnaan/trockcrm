import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { RefreshCcw } from "lucide-react";
import { toast } from "sonner";
import type {
  EscalateConclusionPayload,
  ResolveConclusionPayload,
  SnoozeConclusionPayload,
} from "@/lib/intervention-outcome-taxonomy";
import { buttonVariants } from "@/components/ui/button";
import {
  type InterventionMutationResult,
  type InterventionWorkspaceView,
  batchAssignInterventions,
  batchEscalateInterventions,
  batchResolveInterventions,
  batchSnoozeInterventions,
  summarizeInterventionMutationResult,
  useAdminInterventions,
} from "@/hooks/use-admin-interventions";
import { InterventionBatchToolbar } from "@/components/ai/intervention-batch-toolbar";
import { InterventionDetailPanel } from "@/components/ai/intervention-detail-panel";
import { InterventionQueueTable } from "@/components/ai/intervention-queue-table";
import { InterventionSummaryStrip } from "@/components/ai/intervention-summary-strip";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

function buildSalesProcessDisconnectsHref(searchParams: URLSearchParams) {
  const nextParams = new URLSearchParams();
  const type = searchParams.get("type");
  const cluster = searchParams.get("cluster");
  const trend = searchParams.get("trend");

  if (type) nextParams.set("type", type);
  if (cluster) nextParams.set("cluster", cluster);
  if (trend) nextParams.set("trend", trend);

  const query = nextParams.toString();
  return query ? `/admin/sales-process-disconnects?${query}` : "/admin/sales-process-disconnects";
}

export function AdminInterventionWorkspacePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialView = (searchParams.get("view") as InterventionWorkspaceView | null) ?? "open";
  const initialClusterKey = searchParams.get("clusterKey") ?? "all";
  const caseIdFilter = searchParams.get("caseId");
  const severityFilter = searchParams.get("severity");
  const disconnectTypeFilter = searchParams.get("disconnectType");
  const assigneeIdFilter = searchParams.get("assigneeId");
  const repIdFilter = searchParams.get("repId");
  const companyIdFilter = searchParams.get("companyId");
  const stageKeyFilter = searchParams.get("stageKey");
  const deriveStatusForView = (view: InterventionWorkspaceView): "all" | "open" | "snoozed" | "resolved" => {
    if (view === "all") return "all";
    if (view === "snooze-breached") return "snoozed";
    return "open";
  };
  const [status, setStatus] = useState<"all" | "open" | "snoozed" | "resolved">(
    deriveStatusForView(initialView)
  );
  const [workspaceView, setWorkspaceView] = useState<InterventionWorkspaceView>(initialView);
  const [clusterKey, setClusterKey] = useState<string>(initialClusterKey);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [activeCaseId, setActiveCaseId] = useState<string | null>(null);
  const [batchWorking, setBatchWorking] = useState(false);
  const [detailRefreshToken, setDetailRefreshToken] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 50;
  const { data, loading, error, refetch } = useAdminInterventions({
    page,
    pageSize,
    status,
    view: workspaceView,
    clusterKey: clusterKey === "all" ? null : clusterKey,
    caseId: caseIdFilter,
    severity: severityFilter,
    disconnectType: disconnectTypeFilter,
    assigneeId: assigneeIdFilter,
    repId: repIdFilter,
    companyId: companyIdFilter,
    stageKey: stageKeyFilter,
  });

  function applyWorkspaceView(nextView: InterventionWorkspaceView) {
    setWorkspaceView(nextView);
    setStatus(deriveStatusForView(nextView));
  }

  const items = data?.items ?? [];
  const clusterOptions = useMemo(() => {
    return Array.from(new Set(items.map((item) => item.clusterKey).filter((value): value is string => Boolean(value)))).sort();
  }, [items]);
  const selectedCount = selectedIds.length;

  const selectionSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  useEffect(() => {
    clearSelection();
  }, [clusterKey, page, status, workspaceView]);

  useEffect(() => {
    setPage(1);
  }, [clusterKey, status, workspaceView]);

  useEffect(() => {
    const next = new URLSearchParams();
    if (workspaceView !== "open") next.set("view", workspaceView);
    if (clusterKey !== "all") next.set("clusterKey", clusterKey);
    if (caseIdFilter) next.set("caseId", caseIdFilter);
    if (severityFilter) next.set("severity", severityFilter);
    if (disconnectTypeFilter) next.set("disconnectType", disconnectTypeFilter);
    if (assigneeIdFilter) next.set("assigneeId", assigneeIdFilter);
    if (repIdFilter) next.set("repId", repIdFilter);
    if (companyIdFilter) next.set("companyId", companyIdFilter);
    if (stageKeyFilter) next.set("stageKey", stageKeyFilter);
    setSearchParams(next, { replace: true });
  }, [
    assigneeIdFilter,
    caseIdFilter,
    clusterKey,
    companyIdFilter,
    disconnectTypeFilter,
    repIdFilter,
    setSearchParams,
    severityFilter,
    stageKeyFilter,
    workspaceView,
  ]);

  useEffect(() => {
    if (!caseIdFilter) return;
    setActiveCaseId((current) => (current === caseIdFilter ? current : caseIdFilter));
  }, [caseIdFilter]);

  useEffect(() => {
    const nextView = (searchParams.get("view") as InterventionWorkspaceView | null) ?? "open";
    const nextClusterKey = searchParams.get("clusterKey") ?? "all";
    setWorkspaceView((current) => (current === nextView ? current : nextView));
    setClusterKey((current) => (current === nextClusterKey ? current : nextClusterKey));
    const derivedStatus = deriveStatusForView(nextView);
    setStatus((current) => (current === derivedStatus ? current : derivedStatus));
  }, [searchParams]);

  function clearSelection() {
    setSelectedIds([]);
  }

  function handleToggleSelected(caseId: string, checked: boolean) {
    setSelectedIds((current) => {
      if (checked) return current.includes(caseId) ? current : [...current, caseId];
      return current.filter((id) => id !== caseId);
    });
  }

  function handleToggleAllVisible(checked: boolean) {
    setSelectedIds(checked ? items.map((item) => item.id) : []);
  }

  async function runBatchAction(work: () => Promise<InterventionMutationResult>): Promise<InterventionMutationResult | null> {
    if (selectedIds.length === 0) {
      toast.error("Select at least one intervention case");
      return null;
    }

    setBatchWorking(true);
    let updatedCount = 0;
    try {
      const result = await work();
      updatedCount = result.updatedCount;
      const summary = summarizeInterventionMutationResult(result);
      toast[summary.tone](summary.message);
      if (updatedCount > 0) clearSelection();
      return result;
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to update intervention queue");
      return null;
    } finally {
      if (updatedCount > 0 && activeCaseId !== null && selectedIds.includes(activeCaseId)) {
        setDetailRefreshToken((current) => current + 1);
      }
      await refetch();
      setBatchWorking(false);
    }
  }

  return (
    <div className="p-6 space-y-6 bg-gray-50 min-h-screen">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-black tracking-tighter uppercase text-gray-900">Admin Intervention Workspace</h1>
          <p className="text-[11px] uppercase tracking-widest text-gray-400 mt-1">
            Execution surface for disconnect cases, follow-through artifacts, and direct office interventions
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/admin/intervention-analytics" className={buttonVariants({ variant: "outline" })}>
            View Analytics
          </Link>
          <Link to={buildSalesProcessDisconnectsHref(searchParams)} className={buttonVariants({ variant: "outline" })}>
            View Disconnect Dashboard
          </Link>
          <Button variant="outline" onClick={() => void refetch()} disabled={loading}>
            <RefreshCcw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <InterventionSummaryStrip
        items={items}
        totalCount={data?.totalCount ?? 0}
        totalLabel={
          workspaceView === "all"
            ? "All Cases"
            : workspaceView === "open"
              ? "Open Cases"
              : `${workspaceView.split("-").join(" ").replace(/\b\w/g, (char) => char.toUpperCase())} Cases`
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button variant={status === "open" ? "default" : "outline"} size="sm" onClick={() => setStatus("open")}>
          Open
        </Button>
        <Button variant={status === "snoozed" ? "default" : "outline"} size="sm" onClick={() => setStatus("snoozed")}>
          Snoozed
        </Button>
        <Button variant={status === "resolved" ? "default" : "outline"} size="sm" onClick={() => setStatus("resolved")}>
          Resolved
        </Button>
        <Button variant={status === "all" ? "default" : "outline"} size="sm" onClick={() => setStatus("all")}>
          All
        </Button>
        {selectedCount > 0 && (
          <Button variant="ghost" size="sm" onClick={clearSelection}>
            Clear selection
          </Button>
        )}
      </div>

      <div className="rounded-xl border border-border/80 bg-white p-4 space-y-3">
        <div className="text-sm font-semibold">Saved views</div>
        <div className="flex flex-wrap gap-2">
          <Button variant={workspaceView === "open" ? "default" : "outline"} size="sm" onClick={() => applyWorkspaceView("open")}>
            Open queue
          </Button>
          <Button variant={workspaceView === "escalated" ? "default" : "outline"} size="sm" onClick={() => applyWorkspaceView("escalated")}>
            Escalated
          </Button>
          <Button variant={workspaceView === "unassigned" ? "default" : "outline"} size="sm" onClick={() => applyWorkspaceView("unassigned")}>
            Unassigned
          </Button>
          <Button variant={workspaceView === "aging" ? "default" : "outline"} size="sm" onClick={() => applyWorkspaceView("aging")}>
            Aging
          </Button>
          <Button variant={workspaceView === "repeat" ? "default" : "outline"} size="sm" onClick={() => applyWorkspaceView("repeat")}>
            Repeat
          </Button>
          <Button
            variant={workspaceView === "generated-task-pending" ? "default" : "outline"}
            size="sm"
            onClick={() => applyWorkspaceView("generated-task-pending")}
          >
            Generated Task Pending
          </Button>
          <Button variant={workspaceView === "all" ? "default" : "outline"} size="sm" onClick={() => applyWorkspaceView("all")}>
            All cases
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant={clusterKey === "all" ? "default" : "outline"} size="sm" onClick={() => setClusterKey("all")}>
            All clusters
          </Button>
          {clusterOptions.map((value) => (
            <Button
              key={value}
              variant={clusterKey === value ? "default" : "outline"}
              size="sm"
              onClick={() => setClusterKey(value)}
            >
              {value.split("_").join(" ")}
            </Button>
          ))}
        </div>
      </div>

      <InterventionBatchToolbar
        selectedCount={selectedCount}
        working={batchWorking}
        onAssign={(input) =>
          runBatchAction(() =>
            batchAssignInterventions({
              caseIds: selectedIds,
              assignedTo: input.assignedTo,
              notes: input.notes,
            })
          )
        }
        onSnooze={(input) =>
          runBatchAction(() =>
            batchSnoozeInterventions({
              caseIds: selectedIds,
              conclusion: input.conclusion,
            })
          )
        }
        onResolve={(input: { conclusion: ResolveConclusionPayload }) =>
          runBatchAction(() =>
            batchResolveInterventions({
              caseIds: selectedIds,
              conclusion: input.conclusion,
            })
          )
        }
        onEscalate={(input) =>
          runBatchAction(() =>
            batchEscalateInterventions({
              caseIds: selectedIds,
              conclusion: input.conclusion,
            })
          )
        }
      />

      <Card>
        <CardContent className="p-0">
          <InterventionQueueTable
            items={items}
            selectedIds={[...selectionSet]}
            onToggleSelected={handleToggleSelected}
            onToggleAllVisible={handleToggleAllVisible}
            onOpenDetail={setActiveCaseId}
          />
        </CardContent>
      </Card>

      <div className="flex items-center justify-between gap-3 rounded-xl border border-border/80 bg-white px-4 py-3">
        <div className="text-sm text-muted-foreground">
          Page {data?.page ?? page} of {Math.max(1, Math.ceil((data?.totalCount ?? 0) / pageSize))} · {data?.totalCount ?? 0} total cases
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1 || loading} onClick={() => setPage((current) => Math.max(1, current - 1))}>
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={loading || page >= Math.max(1, Math.ceil((data?.totalCount ?? 0) / pageSize))}
            onClick={() => setPage((current) => current + 1)}
          >
            Next
          </Button>
        </div>
      </div>

      <InterventionDetailPanel
        key={`${activeCaseId ?? "none"}:${detailRefreshToken}`}
        caseId={activeCaseId}
        open={activeCaseId !== null}
        onOpenChange={(open) => {
          if (!open) setActiveCaseId(null);
        }}
        onUpdated={refetch}
      />
    </div>
  );
}
