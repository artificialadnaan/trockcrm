import { PipelineBoard } from "@/components/pipeline/pipeline-board";
import { Button } from "@/components/ui/button";
import type { RepDashboardData } from "@/hooks/use-dashboard";
import type { DealBoardResponse } from "@/hooks/use-deals";
import type { LeadBoardResponse } from "@/hooks/use-leads";
import { useNavigate } from "react-router-dom";

interface RepDashboardBoardShellProps {
  activeEntity: "deals" | "leads";
  onEntityChange: (entity: "deals" | "leads") => void;
  repSummary: RepDashboardData;
  dealBoard: DealBoardResponse | null;
  leadBoard: LeadBoardResponse | null;
}

export function RepDashboardBoardShell({
  activeEntity,
  onEntityChange,
  repSummary,
  dealBoard,
  leadBoard,
}: RepDashboardBoardShellProps) {
  const navigate = useNavigate();
  const boardColumns = activeEntity === "deals" ? dealBoard?.columns ?? [] : leadBoard?.columns ?? [];

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
          loading={false}
          onOpenStage={(stageId) =>
            navigate(`/${activeEntity}/stages/${stageId}?scope=mine`)
          }
          onOpenRecord={(recordId) =>
            navigate(`/${activeEntity}/${recordId}`)
          }
        />
      </section>

      <section aria-label="Secondary summary" className="grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Active Deals</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">{repSummary.activeDeals.count}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Tasks Today</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">
            {repSummary.tasksToday.overdue + repSummary.tasksToday.today}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Stale Leads</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">{repSummary.staleLeads.count}</p>
        </div>
      </section>
    </div>
  );
}
