import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StageChangeDialog } from "@/components/deals/stage-change-dialog";
import { useDealBoard } from "@/hooks/use-deals";
import { useNormalizedPipelineRoute } from "@/lib/pipeline-scope";
import { PipelineBoard } from "@/components/pipeline/pipeline-board";

export function DealListPage() {
  const navigate = useNavigate();
  const { allowedScope: scope, needsRedirect, redirectTo } = useNormalizedPipelineRoute("deals");
  const { board, loading, refetch: refetchBoard } = useDealBoard(scope, true);
  const [pendingMove, setPendingMove] = useState<{ dealId: string; targetStageId: string } | null>(null);
  const [stageChangeOpen, setStageChangeOpen] = useState(false);
  const selectedDeal =
    board?.columns.flatMap((column) => column.cards).find((deal) => deal.id === pendingMove?.dealId) ?? null;

  if (needsRedirect) return <Navigate to={redirectTo} replace />;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-3xl font-semibold tracking-tight text-slate-950">Deals Board</h1>
          <p className="text-sm text-slate-500">
            Move work on the board. Open a stage to inspect it in a paginated workspace.
          </p>
        </div>
        <Button onClick={() => navigate("/deals/new")}>
          <Plus className="mr-2 h-4 w-4" />
          New Deal
        </Button>
      </div>

      <PipelineBoard
        entity="deal"
        loading={loading}
        columns={board?.columns ?? []}
        onOpenStage={(stageId) => navigate(`/deals/stages/${stageId}?scope=${scope}`)}
        onOpenRecord={(dealId) => navigate(`/deals/${dealId}`)}
        onMove={({ activeId, targetStageId }) => {
          setPendingMove({ dealId: activeId, targetStageId });
          setStageChangeOpen(true);
        }}
      />

      {selectedDeal && pendingMove ? (
        <StageChangeDialog
          open={stageChangeOpen}
          deal={selectedDeal}
          targetStageId={pendingMove.targetStageId}
          onOpenChange={(open) => {
            setStageChangeOpen(open);
            if (!open) setPendingMove(null);
          }}
          onSuccess={() => {
            setStageChangeOpen(false);
            setPendingMove(null);
            void refetchBoard();
          }}
        />
      ) : null}
    </div>
  );
}
