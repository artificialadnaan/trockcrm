import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCcw } from "lucide-react";
import { toast } from "sonner";
import { buttonVariants } from "@/components/ui/button";
import {
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
  const [status, setStatus] = useState<"all" | "open" | "snoozed" | "resolved">("open");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [activeCaseId, setActiveCaseId] = useState<string | null>(null);
  const [batchWorking, setBatchWorking] = useState(false);
  const { data, loading, error, refetch } = useAdminInterventions({ page: 1, pageSize: 50, status });

  const items = data?.items ?? [];
  const selectedCount = selectedIds.length;

  const selectionSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  useEffect(() => {
    clearSelection();
  }, [status]);

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

      <InterventionSummaryStrip items={items} />

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
