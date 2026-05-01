import type { PipelineStage } from "@/hooks/use-pipeline-config";
import { isSelectableDealStageSlug } from "@/lib/pipeline-ownership";

export function getNewDealStages(stages: PipelineStage[]) {
  return stages.filter(
    (stage) =>
      stage.isActivePipeline &&
      stage.workflowFamily === "standard_deal" &&
      !stage.isTerminal &&
      isSelectableDealStageSlug(stage.slug),
  );
}

export function getDefaultDealStageId(stages: PipelineStage[]) {
  return getNewDealStages(stages)[0]?.id ?? "";
}

export function getSelectedOptionLabel<T extends { id: string; name: string }>(
  options: T[],
  selectedId: string,
  fallback: string
) {
  return options.find((option) => option.id === selectedId)?.name ?? fallback;
}
