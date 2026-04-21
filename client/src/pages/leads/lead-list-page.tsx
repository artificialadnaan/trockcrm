import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { PipelineBoard } from "@/components/pipeline/pipeline-board";
import { LeadConversionDialog } from "@/components/leads/lead-conversion-dialog";
import { useLeadBoard } from "@/hooks/use-leads";
import { useNormalizedPipelineRoute } from "@/lib/pipeline-scope";

async function moveLeadToStage(leadId: string, targetStageId: string, refetch: () => Promise<unknown> | void) {
  await api(`/leads/${leadId}`, { method: "PATCH", json: { stageId: targetStageId } });
  await refetch();
}

export function LeadListPage() {
  const navigate = useNavigate();
  const { allowedScope: scope, needsRedirect, redirectTo } = useNormalizedPipelineRoute("leads");
  const { board, loading, convertLead, refetch } = useLeadBoard(scope);
  const [conversionLeadId, setConversionLeadId] = useState<string | null>(null);
  const [conversionError, setConversionError] = useState<string | null>(null);

  if (needsRedirect) return <Navigate to={redirectTo} replace />;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-3xl font-semibold tracking-tight text-slate-950">Leads Board</h1>
          <p className="text-sm text-slate-500">
            Leads and deals now share the same board language. Open a stage to inspect its records.
          </p>
        </div>
        <Button onClick={() => navigate("/leads/new")}>
          <Plus className="mr-2 h-4 w-4" />
          New Lead
        </Button>
      </div>

      {conversionError ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {conversionError}
        </div>
      ) : null}

      <PipelineBoard
        entity="lead"
        columns={board?.columns ?? []}
        loading={loading}
        onOpenStage={(stageId) => navigate(`/leads/stages/${stageId}?scope=${scope}`)}
        onOpenRecord={(leadId) => navigate(`/leads/${leadId}`)}
        onMove={({ activeId, targetStageId, targetStageSlug }) => {
          setConversionError(null);
          if (targetStageSlug === "converted") {
            if (!board?.defaultConversionDealStageId) {
              setConversionError("No default deal stage configured");
              return;
            }
            setConversionLeadId(activeId);
            return;
          }
          void moveLeadToStage(activeId, targetStageId, refetch);
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
    </div>
  );
}
