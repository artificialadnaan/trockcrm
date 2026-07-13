import type { WorkflowRoute } from "./workflow.js";

export const ESTIMATOR_PIPELINE_TARGET_KEYS = ["sidney_gibson", "alex_koch"] as const;
export type EstimatorPipelineTargetKey = (typeof ESTIMATOR_PIPELINE_TARGET_KEYS)[number];

export const ESTIMATOR_PIPELINE_BUCKETS = ["target", "other", "missing"] as const;
export type EstimatorPipelineBucket = (typeof ESTIMATOR_PIPELINE_BUCKETS)[number];

export interface EstimatorPipelineMetric {
  count: number;
  value: number;
}
export interface EstimatorPipelineStageColumn {
  stageSlug: string;
  stageLabel: string;
  displayOrder: number;
}

export interface EstimatorPipelineStageSummary extends EstimatorPipelineStageColumn, EstimatorPipelineMetric {}

export interface EstimatorPipelineTargetSummary extends EstimatorPipelineMetric {
  key: EstimatorPipelineTargetKey;
  configuredName: string;
  estimatorUserId: string | null;
  estimatorName: string;
  resolved: boolean;
  active: boolean | null;
  stages: EstimatorPipelineStageSummary[];
}

export interface EstimatorPipelineOtherSummary extends EstimatorPipelineMetric {
  stages: EstimatorPipelineStageSummary[];
}

export interface EstimatorPipelineMissingSummary extends EstimatorPipelineMetric {
  actionableCount: number;
  actionableValue: number;
  stages: EstimatorPipelineStageSummary[];
}

export interface EstimatorPipelineReport {
  generatedAt: string;
  scope: {
    kind: "active_office";
    cohort: "current_open_pipeline";
    note: string;
  };
  valueBasisLabel: "Best current estimate";
  pipeline: EstimatorPipelineMetric;
  stageColumns: EstimatorPipelineStageColumn[];
  estimators: EstimatorPipelineTargetSummary[];
  otherAssigned: EstimatorPipelineOtherSummary;
  missingEstimator: EstimatorPipelineMissingSummary;
  warnings: string[];
}

export type EstimatorAssignmentIssue =
  | "none"
  | "unassigned"
  | "unmapped_legacy"
  | "inactive_estimator";

export interface EstimatorPipelineEvidenceRecord {
  dealId: string;
  dealNumber: string | null;
  projectNumber: string | null;
  dealName: string;
  ownerId: string | null;
  ownerName: string;
  companyName: string | null;
  propertyName: string | null;
  stageSlug: string;
  stageLabel: string;
  displayOrder: number;
  workflowRoute: WorkflowRoute;
  daysInStage: number | null;
  pipelineValue: number;
  expectedCloseDate: string | null;
  estimatorUserId: string | null;
  estimatorName: string | null;
  estimatorActive: boolean | null;
  legacyEstimatorName: string | null;
  assignmentIssue: EstimatorAssignmentIssue;
  isBidBoardOwned: boolean;
}

export interface EstimatorPipelineEvidenceResponse {
  generatedAt: string;
  filter: {
    bucket: EstimatorPipelineBucket;
    estimatorKey: EstimatorPipelineTargetKey | null;
    estimatorName: string | null;
    stageSlug: string | null;
    stageLabel: string | null;
  };
  total: EstimatorPipelineMetric;
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  records: EstimatorPipelineEvidenceRecord[];
}
