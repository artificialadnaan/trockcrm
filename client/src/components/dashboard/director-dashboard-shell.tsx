import { PipelineBoard } from "@/components/pipeline/pipeline-board";
import { Button } from "@/components/ui/button";
import type { DirectorDashboardData } from "@/hooks/use-director-dashboard";
import type { DealBoardResponse } from "@/hooks/use-deals";
import type { LeadBoardResponse } from "@/hooks/use-leads";

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
  const boardColumns = boardEntity === "deals" ? dealBoard?.columns ?? [] : leadBoard?.columns ?? [];

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
          onOpenStage={() => undefined}
          onOpenRecord={() => undefined}
        />
      </section>

      <section aria-label="Secondary analytics" className="grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Pipeline Value</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">{directorSummary.ddVsPipeline.pipelineValue}</p>
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
    </div>
  );
}
