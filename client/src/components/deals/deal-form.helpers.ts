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
