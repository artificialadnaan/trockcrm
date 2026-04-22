import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StageChangeDialog } from "@/components/deals/stage-change-dialog";
import { useDealBoard } from "@/hooks/use-deals";
import { formatCurrencyCompact } from "@/lib/deal-utils";
import { buildDealBoardSummary } from "@/lib/pipeline-board-summary";
import { useNormalizedPipelineRoute } from "@/lib/pipeline-scope";
import { PipelineBoard } from "@/components/pipeline/pipeline-board";

export function DealListPage() {
  const navigate = useNavigate();
  const { allowedScope: scope, needsRedirect, redirectTo } = useNormalizedPipelineRoute("deals");
  const { board, loading, refetch: refetchBoard } = useDealBoard(scope, true);
  const summary = buildDealBoardSummary(board);
  const [pendingMove, setPendingMove] = useState<{ dealId: string; targetStageId: string } | null>(null);
  const [stageChangeOpen, setStageChangeOpen] = useState(false);
  const selectedDeal =
    board?.columns.flatMap((column) => column.cards).find((deal) => deal.id === pendingMove?.dealId) ?? null;

  if (needsRedirect) return <Navigate to={redirectTo} replace />;

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-[2rem] border border-slate-200 bg-white shadow-sm">
        <div className="flex items-start justify-between gap-4 px-7 pb-6 pt-7">
          <div className="space-y-3">
            <div className="space-y-2">
              <h1 className="text-[2.5rem] leading-none font-black tracking-tight text-slate-950">
                Deal Pipeline
              </h1>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm font-semibold text-slate-600">
                <span className="inline-flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-red-500" />
                  <span className="tracking-[0.16em] uppercase">{summary.liveStageCount} Live engine</span>
                </span>
                <span>
                  Total managed:{" "}
                  <span className="font-black text-slate-950">
                    {formatCompactValue(summary.totalValue)}
                  </span>
                </span>
              </div>
            </div>
            <p className="max-w-2xl text-sm text-slate-500">
              Move work on the board. Open a stage to inspect it in a paginated workspace.
            </p>
          </div>
          <Button onClick={() => navigate("/deals/new")}>
            <Plus className="mr-2 h-4 w-4" />
            New Deal
          </Button>
        </div>
        <div className="grid gap-4 border-t border-slate-200 bg-[#f7f8fb] px-7 py-5 md:grid-cols-3">
          <SummaryMetric label="Active deals" value={String(summary.totalCount)} />
          <SummaryMetric label="Avg. stage age" value={`${summary.averageAgeDays} days`} />
          <SummaryMetric label="Live stages" value={String(summary.liveStageCount)} />
        </div>
      </section>

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

function SummaryMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <p className="text-[11px] font-black tracking-[0.18em] text-slate-500 uppercase">{label}</p>
      <p className="text-[2rem] leading-none font-black tracking-tight text-slate-950">{value}</p>
    </div>
  );
}

function formatCompactValue(value: number) {
  return formatCurrencyCompact(value).replace(".0", "");
}
