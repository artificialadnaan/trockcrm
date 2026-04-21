import { PipelineBoard } from "@/components/pipeline/pipeline-board";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/components/charts/chart-colors";
import type { DirectorDashboardData } from "@/hooks/use-director-dashboard";
import type { DealBoardResponse } from "@/hooks/use-deals";
import type { LeadBoardResponse } from "@/hooks/use-leads";
import { useNavigate } from "react-router-dom";

interface DirectorDashboardShellProps {
  boardEntity: "deals" | "leads";
  onBoardEntityChange: (entity: "deals" | "leads") => void;
  directorSummary: DirectorDashboardData;
  dealBoard: DealBoardResponse | null;
  leadBoard: LeadBoardResponse | null;
}

export function DirectorDashboardShell({
  boardEntity,
  onBoardEntityChange,
  directorSummary,
  dealBoard,
  leadBoard,
}: DirectorDashboardShellProps) {
  const navigate = useNavigate();
  const boardColumns = boardEntity === "deals" ? dealBoard?.columns ?? [] : leadBoard?.columns ?? [];
  const teamEarnedCommission = directorSummary.repCommissionRows.reduce(
    (sum, row) => sum + row.totalEarnedCommission,
    0
  );
  const teamPotentialCommission = directorSummary.repCommissionRows.reduce(
    (sum, row) => sum + row.potentialCommission,
    0
  );
  const repsBelowFloor = directorSummary.repCommissionRows.filter((row) => row.floorRemaining > 0).length;

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
          loading={false}
          onOpenStage={(stageId) =>
            navigate(`/${boardEntity}/stages/${stageId}?scope=team`)
          }
          onOpenRecord={(recordId) =>
            navigate(`/${boardEntity}/${recordId}`)
          }
        />
      </section>

      <section aria-label="Secondary analytics" className="grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Pipeline Value</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">
            {formatCurrency(directorSummary.ddVsPipeline.pipelineValue)}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Stale Deals</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">{directorSummary.staleDeals.length}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Stale Leads</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">{directorSummary.staleLeads.length}</p>
        </div>
      </section>

      <section aria-label="Commission visibility" className="grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Team Earned Commission (12M)</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">{formatCurrency(teamEarnedCommission)}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Team Potential Commission</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">{formatCurrency(teamPotentialCommission)}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Reps Below Floor</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">{repsBelowFloor}</p>
        </div>
      </section>
    </div>
  );
}
