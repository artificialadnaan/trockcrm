import type { PipelineStage } from "@/hooks/use-pipeline-config";

const CANONICAL_LEAD_CREATION_STAGE_SLUGS = [
  "new_lead",
  "qualified_lead",
  "sales_validation_stage",
] as const;

function isCanonicalLeadCreationStageSlug(
  value: string
): value is (typeof CANONICAL_LEAD_CREATION_STAGE_SLUGS)[number] {
  return (CANONICAL_LEAD_CREATION_STAGE_SLUGS as readonly string[]).includes(value);
}

export function getLeadCreationStages(stages: PipelineStage[]) {
  const stagePriority = new Map<string, number>(
    CANONICAL_LEAD_CREATION_STAGE_SLUGS.map((slug, index) => [slug, index])
  );

  return stages
    .filter(
      (stage) =>
        stage.workflowFamily === "lead" &&
        stage.isActivePipeline &&
        !stage.isTerminal &&
        isCanonicalLeadCreationStageSlug(stage.slug)
    )
    .sort((left, right) => {
      const leftPriority = stagePriority.get(left.slug) ?? Number.MAX_SAFE_INTEGER;
      const rightPriority = stagePriority.get(right.slug) ?? Number.MAX_SAFE_INTEGER;
      return leftPriority - rightPriority;
    });
}

export function getNormalizedLeadCreationStageId(stages: PipelineStage[], selectedId: string) {
  const creationStages = getLeadCreationStages(stages);
  if (creationStages.length === 0) {
    return "";
  }

  if (selectedId && creationStages.some((stage) => stage.id === selectedId)) {
    return selectedId;
  }

  return creationStages[0]!.id;
}

export function getSelectedOptionLabel<T extends { id: string; name: string }>(
  options: T[],
  selectedId: string,
  fallback: string
) {
  return options.find((option) => option.id === selectedId)?.name ?? fallback;
}
