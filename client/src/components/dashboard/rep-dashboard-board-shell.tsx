import { PipelineBoard } from "@/components/pipeline/pipeline-board";
import { Button } from "@/components/ui/button";
import { useNavigate } from "react-router-dom";
import type { RepDashboardData } from "@/hooks/use-dashboard";
import type { DealBoardResponse } from "@/hooks/use-deals";
import type { LeadBoardResponse } from "@/hooks/use-leads";

interface RepDashboardBoardShellProps {
  activeEntity: "deals" | "leads";
  onEntityChange: (entity: "deals" | "leads") => void;
  repSummary: RepDashboardData | null;
  summaryLoading: boolean;
  summaryError: string | null;
  dealBoard: DealBoardResponse | null;
  dealBoardLoading: boolean;
  leadBoard: LeadBoardResponse | null;
  leadBoardLoading: boolean;
}

export function RepDashboardBoardShell({
  activeEntity,
  onEntityChange,
  repSummary,
  summaryLoading,
  summaryError,
  dealBoard,
  dealBoardLoading,
  leadBoard,
  leadBoardLoading,
}: RepDashboardBoardShellProps) {
  const navigate = useNavigate();
  const boardColumns = activeEntity === "deals" ? dealBoard?.columns ?? [] : leadBoard?.columns ?? [];
  const boardLoading = activeEntity === "deals" ? dealBoardLoading : leadBoardLoading;
  const summaryCards = repSummary
    ? [
        { label: "Active Deals", value: String(repSummary.activeDeals.count) },
        { label: "Tasks Today", value: String(repSummary.tasksToday.overdue + repSummary.tasksToday.today) },
        { label: "Stale Leads", value: String(repSummary.staleLeads.count) },
      ]
    : [];

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-950">My Board</h1>
        <div className="flex items-center gap-2">
          {(["deals", "leads"] as const).map((entity) => (
            <Button
              key={entity}
              variant={activeEntity === entity ? "default" : "outline"}
              aria-pressed={activeEntity === entity}
              onClick={() => onEntityChange(entity)}
            >
              {entity === "deals" ? "Deals" : "Leads"}
            </Button>
          ))}
        </div>
      </div>

      <section aria-label="My Board" className="space-y-4">
        <PipelineBoard
          entity={activeEntity === "deals" ? "deal" : "lead"}
          columns={boardColumns}
          loading={boardLoading}
          onOpenStage={(stageId) => navigate(`/${activeEntity}/stages/${stageId}?scope=mine`)}
          onOpenRecord={(recordId) => navigate(activeEntity === "deals" ? `/deals/${recordId}` : `/leads/${recordId}`)}
        />
      </section>

      {summaryError ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {summaryError}
        </div>
      ) : null}

      <section aria-label="Secondary summary" className="grid gap-4 md:grid-cols-3">
        {summaryLoading && !repSummary ? (
          Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="h-3 w-24 animate-pulse rounded bg-slate-100" />
              <div className="mt-3 h-8 w-16 animate-pulse rounded bg-slate-100" />
            </div>
          ))
        ) : (
          summaryCards.map((card) => (
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
