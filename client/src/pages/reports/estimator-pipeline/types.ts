import type {
  EstimatorPipelineBucket,
  EstimatorPipelineTargetKey,
  EstimatorPipelineWonPeriod,
} from "@trock-crm/shared/types";

interface EstimatorDrillSelectionBase {
  bucket: EstimatorPipelineBucket;
  estimatorKey?: EstimatorPipelineTargetKey;
  title: string;
  description: string;
}

export type EstimatorDrillSelection = EstimatorDrillSelectionBase & (
  | { cohort: "open"; stageSlug?: string; period?: never }
  | { cohort: "won"; stageSlug?: never; period: EstimatorPipelineWonPeriod }
);
