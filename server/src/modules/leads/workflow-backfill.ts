import {
  CRM_OWNED_LEAD_STAGE_LABELS,
  type CrmOwnedLeadStageSlug,
} from "@trock-crm/shared/types";
import type { WorkflowRoute } from "@trock-crm/shared/types";

const SERVICE_ROUTE_THRESHOLD = 50000;
type LeadBackfillStageSlug = Exclude<CrmOwnedLeadStageSlug, "opportunity">;

export interface LegacyLeadStageHistoryEntry {
  fromStageId: string | null;
  toStageId: string;
  changedAt: Date | string | null;
}

export interface PlanLeadWorkflowBackfillInput {
  id: string;
  legacyStageSlug?: string | null;
  legacyStageName?: string | null;
  preQualValue?: number | string | null;
  pipelineType?: WorkflowRoute | null;
  projectTypeId?: string | null;
  qualificationPayload?: Record<string, unknown> | null;
  projectTypeQuestionPayload?: Record<string, unknown> | null;
  submissionCompletedAt?: Date | string | null;
  executiveDecision?: string | null;
  source?: string | null;
  sourceLeadId?: string | null;
  convertedDealId?: string | null;
  stageHistory?: LegacyLeadStageHistoryEntry[];
}

export interface LeadWorkflowBackfillPlan {
  targetStageSlug: LeadBackfillStageSlug;
  targetStageLabel: string;
  workflowRoute: WorkflowRoute;
  preservedStageHistory: LegacyLeadStageHistoryEntry[];
  sourceLinkage: {
    source: string | null;
    sourceLeadId: string | null;
    convertedDealId: string | null;
  };
}

function parseNumericValue(value: number | string | null | undefined): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function hasPayloadValues(value: Record<string, unknown> | null | undefined) {
  return Boolean(value && Object.keys(value).length > 0);
}

function normalizeSignal(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? "";
}

function resolveWorkflowRoute(input: PlanLeadWorkflowBackfillInput): WorkflowRoute {
  const preQualValue = parseNumericValue(input.preQualValue);
  if (preQualValue !== null) {
    return preQualValue < SERVICE_ROUTE_THRESHOLD ? "service" : "normal";
  }

  return input.pipelineType === "service" ? "service" : "normal";
}

function resolveLeadStage(input: PlanLeadWorkflowBackfillInput): LeadBackfillStageSlug {
  const stageSlug = normalizeSignal(input.legacyStageSlug);
  const stageName = normalizeSignal(input.legacyStageName);

  if (
    stageSlug === "sales_validation_stage" ||
    stageSlug === "opportunity" ||
    stageSlug === "converted" ||
    stageName.includes("validation") ||
    stageName.includes("opportunity") ||
    stageName.includes("converted") ||
    input.submissionCompletedAt ||
    normalizeSignal(input.executiveDecision).length > 0
  ) {
    return "sales_validation_stage";
  }

  if (
    stageSlug === "qualified_lead" ||
    stageName.includes("qualified") ||
    input.projectTypeId ||
    parseNumericValue(input.preQualValue) !== null ||
    hasPayloadValues(input.qualificationPayload) ||
    hasPayloadValues(input.projectTypeQuestionPayload)
  ) {
    return "qualified_lead";
  }

  return "new_lead";
}

export function planLeadWorkflowBackfill(
  input: PlanLeadWorkflowBackfillInput
): LeadWorkflowBackfillPlan {
  const targetStageSlug = resolveLeadStage(input);

  return {
    targetStageSlug,
    targetStageLabel: CRM_OWNED_LEAD_STAGE_LABELS[targetStageSlug],
    workflowRoute: resolveWorkflowRoute(input),
    preservedStageHistory: input.stageHistory ?? [],
    sourceLinkage: {
      source: input.source ?? null,
      sourceLeadId: input.sourceLeadId ?? null,
      convertedDealId: input.convertedDealId ?? null,
    },
  };
}
