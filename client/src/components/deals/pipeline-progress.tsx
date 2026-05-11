import { CheckCircle2, Circle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { isEstimatingBoundaryStageSlug } from "@/lib/pipeline-ownership";

export type PipelineProgressStage = {
  id: string;
  name: string;
  slug: string;
  displayOrder: number;
  isTerminal?: boolean | null;
};

type PipelineProgressProps = {
  stages: PipelineProgressStage[];
  currentStageId: string | null | undefined;
  workflowRoute: "normal" | "service";
  isBidBoardOwned: boolean;
  handoffStageDisplayOrder: number | null;
  canMoveBackward: boolean;
  onStageClick: (stageId: string) => void;
};

const EYEBROW = "text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500";

function getDisabledReason(
  stage: PipelineProgressStage,
  index: number,
  currentIndex: number,
  options: Pick<PipelineProgressProps, "workflowRoute" | "isBidBoardOwned" | "handoffStageDisplayOrder" | "canMoveBackward">
) {
  if (currentIndex === -1 || index === currentIndex) {
    return "current";
  }

  if (stage.isTerminal && index < currentIndex) {
    return "terminal-passed";
  }

  if (
    options.isBidBoardOwned &&
    !isEstimatingBoundaryStageSlug(stage.slug, options.workflowRoute) &&
    (options.handoffStageDisplayOrder == null || stage.displayOrder > options.handoffStageDisplayOrder)
  ) {
    return "bid-board-managed";
  }

  if (index < currentIndex && !options.canMoveBackward) {
    return "backward-restricted";
  }

  return null;
}

function disabledLabel(reason: string | null) {
  switch (reason) {
    case "bid-board-managed":
      return "Managed";
    case "backward-restricted":
      return "Director only";
    case "terminal-passed":
      return "Passed";
    default:
      return null;
  }
}

export function PipelineProgress({
  stages,
  currentStageId,
  workflowRoute,
  isBidBoardOwned,
  handoffStageDisplayOrder,
  canMoveBackward,
  onStageClick,
}: PipelineProgressProps) {
  if (stages.length === 0) {
    return null;
  }

  const currentIndex = stages.findIndex((stage) => stage.id === currentStageId);

  return (
    <Card>
      <CardContent className="p-5">
        <p className={EYEBROW}>Pipeline progress</p>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
          {stages.map((stage, index) => {
            const isComplete = currentIndex > -1 && index < currentIndex;
            const isCurrent = index === currentIndex;
            const disabledReason = getDisabledReason(stage, index, currentIndex, {
              workflowRoute,
              isBidBoardOwned,
              handoffStageDisplayOrder,
              canMoveBackward,
            });
            const disabled = disabledReason != null;
            const label = disabledLabel(disabledReason);
            const state = isCurrent ? "current" : isComplete ? "complete" : "upcoming";

            return (
              <button
                key={stage.id}
                type="button"
                aria-current={isCurrent ? "step" : undefined}
                aria-disabled={disabled}
                disabled={disabled}
                data-stage-slug={stage.slug}
                data-state={state}
                data-disabled-reason={disabledReason ?? undefined}
                onClick={() => onStageClick(stage.id)}
                className={cn(
                  "group flex min-w-0 flex-col rounded-md border border-transparent p-2 text-left transition",
                  disabled ? "cursor-not-allowed" : "hover:border-slate-200 hover:bg-slate-50",
                  isCurrent && "bg-red-50/60",
                )}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    className={cn(
                      "shrink-0",
                      isCurrent ? "text-brand-red" : isComplete ? "text-emerald-500" : "text-slate-400"
                    )}
                  >
                    {isComplete ? (
                      <CheckCircle2 className="h-4 w-4" />
                    ) : isCurrent ? (
                      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-brand-red text-[9px] font-black text-white">
                        {index + 1}
                      </span>
                    ) : (
                      <Circle className="h-4 w-4" />
                    )}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 break-words text-[10px] font-bold uppercase leading-tight tracking-wide",
                      isCurrent ? "text-brand-red" : isComplete ? "text-slate-700" : "text-slate-400"
                    )}
                  >
                    {stage.name}
                  </span>
                </span>
                <span
                  className={cn(
                    "mt-3 h-1 w-full rounded-full",
                    isCurrent ? "bg-brand-red" : isComplete ? "bg-emerald-400" : "bg-slate-200"
                  )}
                />
                {label ? (
                  <span className="mt-2 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">
                    {label}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
