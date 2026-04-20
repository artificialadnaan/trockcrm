import type { PipelineStage } from "@/hooks/use-pipeline-config";

export function getLeadCreationStages(stages: PipelineStage[]) {
  return stages.filter((stage) => stage.workflowFamily === "lead" && !stage.isTerminal);
}

export function getSelectedOptionLabel<T extends { id: string; name: string }>(
  options: T[],
  selectedId: string,
  fallback: string
) {
  return options.find((option) => option.id === selectedId)?.name ?? fallback;
}
