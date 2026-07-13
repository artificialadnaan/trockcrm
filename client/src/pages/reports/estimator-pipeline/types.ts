import type { EstimatorPipelineBucket, EstimatorPipelineTargetKey } from "@trock-crm/shared/types";

export interface EstimatorDrillSelection {
  bucket: EstimatorPipelineBucket;
  estimatorKey?: EstimatorPipelineTargetKey;
  stageSlug?: string;
  title: string;
  description: string;
}
