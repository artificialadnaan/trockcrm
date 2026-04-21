import { useMemo, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRight, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PipelineBoard } from "@/components/pipeline/pipeline-board";
import { LeadConversionDialog } from "@/components/leads/lead-conversion-dialog";
import { transitionLeadStage, useLeadBoard } from "@/hooks/use-leads";
import { useNormalizedPipelineRoute } from "@/lib/pipeline-scope";

export function isImmediateNextStageMove(
  currentStageId: string,
  targetStageId: string,
  nextStageById: Map<string, string | null>
) {
  return nextStageById.get(currentStageId) === targetStageId;
}

export function isValidDirectorDecisionForTarget(
  targetStageSlug: string | undefined,
  decision: "" | "go" | "no_go"
) {
  if (targetStageSlug === "ready_for_opportunity") return decision === "go";
  return decision === "go" || decision === "no_go";
}

export function LeadListPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { allowedScope: scope, needsRedirect, redirectTo } = useNormalizedPipelineRoute("leads");
  const { board, loading, convertLead, refetch } = useLeadBoard(scope);
  const [conversionLeadId, setConversionLeadId] = useState<string | null>(null);
  const [blockedMove, setBlockedMove] = useState<{
    leadId: string;
    leadName: string;
    targetStageName: string;
    missingLabels: string[];
  } | null>(null);

  const bucket = searchParams.get("bucket");
  const stageIndexById = useMemo(
    () =>
      new Map((board?.columns ?? []).map((column, index) => [column.stage.id, index])),
    [board?.columns]
  );
  const filteredColumns = useMemo(() => {
    const columns = board?.columns ?? [];
    if (!bucket) return columns;

    return columns.filter((column) => {
      const slug = column.stage.slug;
      if (bucket === "lead") return slug === "contacted";
      if (bucket === "qualified_lead") return slug === "qualified_lead";
      if (bucket === "opportunity") {
        return slug === "director_go_no_go" || slug === "ready_for_opportunity";
      }
      return true;
    });
  }, [board?.columns, bucket]);

  if (needsRedirect) return <Navigate to={redirectTo} replace />;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-3xl font-semibold tracking-tight text-slate-950">Leads Board</h1>
          <p className="text-sm text-slate-500">
            Use the board to move active leads forward. Open a stage to inspect it in a paginated workspace.
          </p>
        </div>
        <Button onClick={() => navigate("/leads/new")}>
          <Plus className="mr-2 h-4 w-4" />
          New Lead
        </Button>
      </div>

      <PipelineBoard
        entity="lead"
        columns={filteredColumns}
        loading={loading}
        onOpenStage={(stageId) => navigate(`/leads/stages/${stageId}?scope=${scope}`)}
        onOpenRecord={(leadId) => navigate(`/leads/${leadId}`)}
        onMove={({ activeId, targetStageId, targetStageSlug }) => {
          const sourceColumn = (board?.columns ?? []).find((column) =>
            column.cards.some((card) => card.id === activeId)
          );
          const targetColumn = (board?.columns ?? []).find((column) => column.stage.id === targetStageId);
          const activeLead = sourceColumn?.cards.find((card) => card.id === activeId) ?? null;

          if (!sourceColumn || !targetColumn || !activeLead || sourceColumn.stage.id === targetStageId) {
            return;
          }

          const currentIndex = stageIndexById.get(sourceColumn.stage.id) ?? -1;
          const nextIndex = stageIndexById.get(targetStageId) ?? -1;

          if (targetStageSlug === "converted") {
            if (!board?.defaultConversionDealStageId) {
              toast.error("No default deal stage is configured for lead conversion.");
              return;
            }
            setConversionLeadId(activeId);
            return;
          }

          if (nextIndex !== currentIndex + 1) {
            toast.error("Leads can only move one stage forward at a time.");
            return;
          }

          void transitionLeadStage(activeId, { targetStageId })
            .then(async (result) => {
              if (result.ok) {
                await refetch();
                return;
              }

              setBlockedMove({
                leadId: activeLead.id,
                leadName: activeLead.name,
                targetStageName: targetColumn.stage.name,
                missingLabels: result.missing.map((item) => item.label),
              });
            })
            .catch((error: unknown) => {
              toast.error(error instanceof Error ? error.message : "Failed to move lead");
            });
        }}
      />

      <LeadConversionDialog
        leadId={conversionLeadId}
        defaultDealStageId={board?.defaultConversionDealStageId ?? null}
        defaultWorkflowRoute="estimating"
        onConfirm={async (input) => {
          await convertLead(input);
          await refetch();
          setConversionLeadId(null);
        }}
        onOpenChange={(open) => {
          if (!open) setConversionLeadId(null);
        }}
      />

      <Dialog open={blockedMove !== null} onOpenChange={(open) => !open && setBlockedMove(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Complete Required Fields</DialogTitle>
            <DialogDescription>
              This lead cannot move to {blockedMove?.targetStageName ?? "the selected stage"} yet.
            </DialogDescription>
          </DialogHeader>
          {blockedMove ? (
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
              <p className="font-semibold text-slate-950">{blockedMove.leadName}</p>
              <p className="mt-1">{blockedMove.missingLabels.join(", ")}</p>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setBlockedMove(null)}>
              Close
            </Button>
            {blockedMove ? (
              <Button onClick={() => navigate(`/leads/${blockedMove.leadId}`)}>
                Open Lead
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
