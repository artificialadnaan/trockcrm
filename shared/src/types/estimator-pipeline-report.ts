import type { WorkflowRoute } from "./workflow.js";

/**
 * The report "key" identifying an estimator row is that estimator's CRM user id (a UUID string).
 * The roster is derived dynamically from BID_BOARD_ESTIMATOR_USER_MAP, so there is no longer a fixed
 * enum of target keys. Evidence drill-downs pass this userId as `estimatorKey`.
 */
export type EstimatorPipelineTargetKey = string;

export const ESTIMATOR_PIPELINE_BUCKETS = ["target", "other", "missing"] as const;
export type EstimatorPipelineBucket = (typeof ESTIMATOR_PIPELINE_BUCKETS)[number];

export const ESTIMATOR_PIPELINE_COHORTS = ["open", "won"] as const;
export type EstimatorPipelineCohort = (typeof ESTIMATOR_PIPELINE_COHORTS)[number];

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
  won: EstimatorPipelineMetric;
  stages: EstimatorPipelineStageSummary[];
}

export interface EstimatorPipelineOtherSummary extends EstimatorPipelineMetric {
  won: EstimatorPipelineMetric;
  stages: EstimatorPipelineStageSummary[];
}

export interface EstimatorPipelineMissingSummary extends EstimatorPipelineMetric {
  actionableCount: number;
  actionableValue: number;
  won: EstimatorPipelineMetric;
  stages: EstimatorPipelineStageSummary[];
}

export interface EstimatorPipelineWonPeriod {
  from: string;
  to: string;
  label: "Won YTD";
}

export interface EstimatorPipelineReport {
  generatedAt: string;
  scope: {
    kind: "active_office";
    cohort: "current_open_pipeline_plus_won_ytd";
    note: string;
  };
  /** @deprecated Use valueBasisLabels.open. Retained for rolling-deploy compatibility. */
  valueBasisLabel: "Best current estimate";
  valueBasisLabels: {
    open: "Best current estimate";
    won: "Awarded-first won value";
  };
  pipeline: EstimatorPipelineMetric;
  won: EstimatorPipelineMetric;
  wonPeriod: EstimatorPipelineWonPeriod;
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
  wonClosedDate: string | null;
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
    cohort: EstimatorPipelineCohort;
    bucket: EstimatorPipelineBucket;
    estimatorKey: EstimatorPipelineTargetKey | null;
    estimatorName: string | null;
    stageSlug: string | null;
    stageLabel: string | null;
    valueBasisLabel: "Best current estimate" | "Awarded-first won value";
    period: EstimatorPipelineWonPeriod | null;
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
