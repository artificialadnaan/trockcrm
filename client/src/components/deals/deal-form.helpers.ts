import type { PipelineStage } from "@/hooks/use-pipeline-config";

export function getNewDealStages(stages: PipelineStage[]) {
  return stages.filter(
    (stage) =>
      stage.workflowFamily === "standard_deal" &&
      !stage.isTerminal,
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
