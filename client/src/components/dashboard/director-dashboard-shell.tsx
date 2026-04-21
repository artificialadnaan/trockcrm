import { PipelineBoard } from "@/components/pipeline/pipeline-board";
import { Button } from "@/components/ui/button";
import { useNavigate } from "react-router-dom";
import type { DirectorDashboardData } from "@/hooks/use-director-dashboard";
import type { DealBoardResponse } from "@/hooks/use-deals";
import type { LeadBoardResponse } from "@/hooks/use-leads";

interface DirectorDashboardShellProps {
  boardEntity: "deals" | "leads";
  onBoardEntityChange: (entity: "deals" | "leads") => void;
  directorSummary: DirectorDashboardData | null;
  summaryLoading: boolean;
  summaryError: string | null;
  dealBoard: DealBoardResponse | null;
  dealBoardLoading: boolean;
  leadBoard: LeadBoardResponse | null;
  leadBoardLoading: boolean;
}

export function DirectorDashboardShell({
  boardEntity,
  onBoardEntityChange,
  directorSummary,
  summaryLoading,
  summaryError,
  dealBoard,
  dealBoardLoading,
  leadBoard,
  leadBoardLoading,
}: DirectorDashboardShellProps) {
  const navigate = useNavigate();
  const boardColumns = boardEntity === "deals" ? dealBoard?.columns ?? [] : leadBoard?.columns ?? [];
  const boardLoading = boardEntity === "deals" ? dealBoardLoading : leadBoardLoading;
  const analyticsCards = directorSummary
    ? [
        { label: "Pipeline Value", value: String(directorSummary.ddVsPipeline.pipelineValue) },
        { label: "Stale Deals", value: String(directorSummary.staleDeals.length) },
        { label: "Stale Leads", value: String(directorSummary.staleLeads.length) },
      ]
    : [];

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-950">Team Pipeline Console</h1>
        <div className="flex items-center gap-2">
          {(["deals", "leads"] as const).map((entity) => (
            <Button
              key={entity}
              variant={boardEntity === entity ? "default" : "outline"}
              aria-pressed={boardEntity === entity}
              onClick={() => onBoardEntityChange(entity)}
            >
              {entity === "deals" ? "Deals" : "Leads"}
            </Button>
          ))}
        </div>
      </div>

      <section aria-label="Primary workspace" className="space-y-4">
        <PipelineBoard
          entity={boardEntity === "deals" ? "deal" : "lead"}
          columns={boardColumns}
          loading={boardLoading}
          onOpenStage={(stageId) => navigate(`/${boardEntity}/stages/${stageId}?scope=team`)}
          onOpenRecord={(recordId) => navigate(boardEntity === "deals" ? `/deals/${recordId}` : `/leads/${recordId}`)}
        />
      </section>

      {summaryError ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {summaryError}
        </div>
      ) : null}

      <section aria-label="Secondary analytics" className="grid gap-4 md:grid-cols-3">
        {summaryLoading && !directorSummary ? (
          Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="h-3 w-28 animate-pulse rounded bg-slate-100" />
              <div className="mt-3 h-8 w-20 animate-pulse rounded bg-slate-100" />
            </div>
          ))
        ) : (
          analyticsCards.map((card) => (
            <div key={card.label} className="rounded-2xl border border-slate-200 bg-white p-4">
              <p className="text-xs uppercase tracking-[0.16em] text-slate-500">{card.label}</p>
              <p className="mt-2 text-3xl font-semibold text-slate-950">{card.value}</p>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
