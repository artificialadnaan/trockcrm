import { PipelineBoard } from "@/components/pipeline/pipeline-board";
import { Button } from "@/components/ui/button";
import type { DealBoardResponse } from "@/hooks/use-deals";
import type { LeadBoardResponse } from "@/hooks/use-leads";
import { useNavigate } from "react-router-dom";

interface DirectorDashboardShellProps {
  boardEntity: "deals" | "leads";
  onBoardEntityChange: (entity: "deals" | "leads") => void;
  dealBoard: DealBoardResponse | null;
  leadBoard: LeadBoardResponse | null;
  loading: boolean;
  error: string | null;
}

export function DirectorDashboardShell({
  boardEntity,
  onBoardEntityChange,
  dealBoard,
  leadBoard,
  loading,
  error,
}: DirectorDashboardShellProps) {
  const navigate = useNavigate();
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
        {error ? (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {error}
          </div>
        ) : null}
        <PipelineBoard
          entity={boardEntity === "deals" ? "deal" : "lead"}
          columns={boardColumns}
          loading={loading}
          onOpenStage={(stageId) =>
            navigate(`/${boardEntity}/stages/${stageId}?scope=team`)
          }
          onOpenRecord={(recordId) =>
            navigate(`/${boardEntity}/${recordId}`)
          }
        />
      </section>
    </div>
  );
}
