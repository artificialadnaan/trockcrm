import type { PipelineStage } from "@/hooks/use-pipeline-config";

export function getLeadCreationStages(stages: PipelineStage[]) {
  return stages.filter((stage) => stage.workflowFamily === "lead" && !stage.isTerminal);
}
