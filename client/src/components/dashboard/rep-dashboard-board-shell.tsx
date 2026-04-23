import { PipelineBoard } from "@/components/pipeline/pipeline-board";
import { Button } from "@/components/ui/button";
import type { DealBoardResponse } from "@/hooks/use-deals";
import type { LeadBoardResponse } from "@/hooks/use-leads";
import { useNavigate } from "react-router-dom";

interface RepDashboardBoardShellProps {
  activeEntity: "deals" | "leads";
  onEntityChange: (entity: "deals" | "leads") => void;
  dealBoard: DealBoardResponse | null;
  leadBoard: LeadBoardResponse | null;
  loading: boolean;
  error: string | null;
  onMove?: (input: {
    activeId: string;
    targetStageId: string;
    targetStageSlug: string;
    entity: "deal" | "lead";
  }) => void;
}

export function RepDashboardBoardShell({
  activeEntity,
  onEntityChange,
  dealBoard,
  leadBoard,
  loading,
  error,
  onMove,
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
        {error ? (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {error}
          </div>
        ) : null}
        <PipelineBoard
          entity={activeEntity === "deals" ? "deal" : "lead"}
          columns={boardColumns}
          loading={loading}
          onOpenStage={(stageId) =>
            navigate(`/${activeEntity}/stages/${stageId}?scope=mine`)
          }
          onOpenRecord={(recordId) =>
            navigate(`/${activeEntity}/${recordId}`)
          }
          onMove={
            onMove
              ? (input) => onMove({ ...input, entity: activeEntity === "deals" ? "deal" : "lead" })
              : undefined
          }
        />
      </section>
    </div>
  );
}
