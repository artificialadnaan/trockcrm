import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { RefreshCcw } from "lucide-react";
import { toast } from "sonner";
import { buttonVariants } from "@/components/ui/button";
import {
  type InterventionWorkspaceView,
  type InterventionResolutionReason,
  batchAssignInterventions,
  batchEscalateInterventions,
  batchResolveInterventions,
  batchSnoozeInterventions,
  useAdminInterventions,
} from "@/hooks/use-admin-interventions";
import { InterventionBatchToolbar } from "@/components/ai/intervention-batch-toolbar";
import { InterventionDetailPanel } from "@/components/ai/intervention-detail-panel";
import { InterventionQueueTable } from "@/components/ai/intervention-queue-table";
import { InterventionSummaryStrip } from "@/components/ai/intervention-summary-strip";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export function AdminInterventionWorkspacePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialView = (searchParams.get("view") as InterventionWorkspaceView | null) ?? "open";
  const initialClusterKey = searchParams.get("clusterKey") ?? "all";
  const [status, setStatus] = useState<"all" | "open" | "snoozed" | "resolved">("open");
  const [workspaceView, setWorkspaceView] = useState<InterventionWorkspaceView>(initialView);
  const [clusterKey, setClusterKey] = useState<string>(initialClusterKey);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [activeCaseId, setActiveCaseId] = useState<string | null>(null);
  const [batchWorking, setBatchWorking] = useState(false);
  const [page, setPage] = useState(1);
  const pageSize = 50;
  const { data, loading, error, refetch } = useAdminInterventions({ page, pageSize, status });

  function applyWorkspaceView(nextView: InterventionWorkspaceView) {
    setWorkspaceView(nextView);
    if (nextView === "all") {
      setStatus("all");
      return;
    }
    if (nextView === "open") {
      setStatus("open");
    }
  }

  const rawItems = data?.items ?? [];
  const clusterOptions = useMemo(() => {
    return Array.from(new Set(rawItems.map((item) => item.clusterKey).filter((value): value is string => Boolean(value)))).sort();
  }, [rawItems]);

  const items = useMemo(() => {
    return rawItems.filter((item) => {
      if (clusterKey !== "all" && item.clusterKey !== clusterKey) return false;

      switch (workspaceView) {
        case "all":
          return true;
        case "escalated":
          return item.escalated;
        case "unassigned":
          return !item.assignedTo;
        case "aging":
          return item.ageDays >= 7;
        case "repeat":
          return item.reopenCount > 0;
        case "generated-task-pending":
          return item.generatedTask !== null && item.generatedTask.status !== "completed" && item.generatedTask.status !== "dismissed";
        case "open":
        default:
          return item.status === "open";
      }
    });
  }, [clusterKey, rawItems, workspaceView]);
  const selectedCount = selectedIds.length;

  const selectionSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  useEffect(() => {
    clearSelection();
  }, [clusterKey, status, workspaceView]);

  useEffect(() => {
    setPage(1);
  }, [clusterKey, status, workspaceView]);

  useEffect(() => {
    const next = new URLSearchParams();
    if (workspaceView !== "open") next.set("view", workspaceView);
    if (clusterKey !== "all") next.set("clusterKey", clusterKey);
    setSearchParams(next, { replace: true });
  }, [clusterKey, setSearchParams, workspaceView]);

  useEffect(() => {
    const nextView = (searchParams.get("view") as InterventionWorkspaceView | null) ?? "open";
    const nextClusterKey = searchParams.get("clusterKey") ?? "all";
    setWorkspaceView((current) => (current === nextView ? current : nextView));
    setClusterKey((current) => (current === nextClusterKey ? current : nextClusterKey));
    if (nextView === "all") {
      setStatus((current) => (current === "all" ? current : "all"));
    } else if (nextView === "open") {
      setStatus((current) => (current === "open" ? current : "open"));
    }
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

  async function runBatchAction(work: () => Promise<unknown>) {
    if (selectedIds.length === 0) {
      toast.error("Select at least one intervention case");
      return;
    }

    setBatchWorking(true);
    try {
      await work();
      toast.success("Intervention queue updated");
      clearSelection();
      await refetch();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to update intervention queue");
    } finally {
      setBatchWorking(false);
    }
  }

  return (
    <div className="p-6 space-y-6 bg-gray-50 min-h-screen">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-black tracking-tighter uppercase text-gray-900">Admin Intervention Workspace</h1>
          <p className="text-[11px] uppercase tracking-widest text-gray-400 mt-1">
            Manager-first queue for disconnect cases, execution artifacts, and direct office interventions
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/admin/sales-process-disconnects" className={buttonVariants({ variant: "outline" })}>
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

      <InterventionSummaryStrip items={items} totalCount={data?.totalCount ?? 0} />

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
              snoozedUntil: input.snoozedUntil,
              notes: input.notes,
            })
          )
        }
        onResolve={(input: { resolutionReason: InterventionResolutionReason; notes: string | null }) =>
          runBatchAction(() =>
            batchResolveInterventions({
              caseIds: selectedIds,
              resolutionReason: input.resolutionReason,
              notes: input.notes,
            })
          )
        }
        onEscalate={(input) =>
          runBatchAction(() =>
            batchEscalateInterventions({
              caseIds: selectedIds,
              notes: input.notes,
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
