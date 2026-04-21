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
import { transitionLeadStage, useLeadBoard } from "@/hooks/use-leads";
import { useNormalizedPipelineRoute } from "@/lib/pipeline-scope";

export function buildLeadIntakePath(leadId: string, focus: "qualification" | "scoping" = "qualification") {
  return `/leads/${leadId}?focus=${focus}`;
}

export function isImmediateNextStageMove(
  currentStageId: string,
  targetStageId: string,
  nextStageById: Map<string, string | null>
) {
  return nextStageById.get(currentStageId) === targetStageId;
}

function matchesLeadBucket(bucket: string | null, slug: string) {
  if (!bucket) return true;
  if (bucket === "lead") {
    return ["lead_new", "company_pre_qualified", "scoping_in_progress", "contacted"].includes(slug);
  }
  if (bucket === "qualified_lead") {
    return ["pre_qual_value_assigned", "lead_go_no_go", "qualified_lead"].includes(slug);
  }
  if (bucket === "opportunity") {
    return ["qualified_for_opportunity", "director_go_no_go", "ready_for_opportunity"].includes(slug);
  }
  return true;
}

export function LeadListPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { allowedScope: scope, needsRedirect, redirectTo } = useNormalizedPipelineRoute("leads");
  const { board, loading, refetch } = useLeadBoard(scope);
  const [blockedMove, setBlockedMove] = useState<{
    leadId: string;
    leadName: string;
    targetStageName: string;
    missingLabels: string[];
    focus: "qualification" | "scoping";
  } | null>(null);

  const bucket = searchParams.get("bucket");
  const nextStageById = useMemo(
    () =>
      new Map(
        (board?.columns ?? []).map((column, index, columns) => [
          column.stage.id,
          columns[index + 1]?.stage.id ?? null,
        ])
      ),
    [board?.columns]
  );
  const filteredColumns = useMemo(
    () => (board?.columns ?? []).filter((column) => matchesLeadBucket(bucket, column.stage.slug)),
    [board?.columns, bucket]
  );

  if (needsRedirect) return <Navigate to={redirectTo} replace />;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-3xl font-semibold tracking-tight text-slate-950">Leads Board</h1>
          <p className="text-sm text-slate-500">
            Use the board to move active leads forward. Open a lead to complete qualification intake and convert to Opportunity.
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
        onMove={({ activeId, targetStageId }) => {
          const sourceColumn = (board?.columns ?? []).find((column) =>
            column.cards.some((card) => card.id === activeId)
          );
          const targetColumn = (board?.columns ?? []).find((column) => column.stage.id === targetStageId);
          const activeLead = sourceColumn?.cards.find((card) => card.id === activeId) ?? null;

          if (!sourceColumn || !targetColumn || !activeLead || sourceColumn.stage.id === targetStageId) {
            return;
          }

          if (!isImmediateNextStageMove(sourceColumn.stage.id, targetStageId, nextStageById)) {
            toast.error("Leads can only move one stage forward at a time.");
            return;
          }

          void transitionLeadStage(activeId, { targetStageId })
            .then(async (result) => {
              if (!result.ok) {
                const missingKeys = result.missingRequirements.effectiveChecklist.fields
                  .filter((field) => !field.satisfied)
                  .map((field) => field.key);
                setBlockedMove({
                  leadId: activeLead.id,
                  leadName: activeLead.name,
                  targetStageName: targetColumn.stage.name,
                  missingLabels: result.missingRequirements.effectiveChecklist.fields
                    .filter((field) => !field.satisfied)
                    .map((field) => field.label),
                  focus: missingKeys.some((key) => key.startsWith("leadScoping."))
                    ? "scoping"
                    : "qualification",
                });
                return;
              }

              await refetch();
            })
            .catch((error: unknown) => {
              toast.error(error instanceof Error ? error.message : "Failed to move lead");
            });
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
              <Button onClick={() => navigate(buildLeadIntakePath(blockedMove.leadId, blockedMove.focus))}>
                Open Lead Intake
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
