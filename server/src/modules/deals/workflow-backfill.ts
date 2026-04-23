import { BID_BOARD_MIRRORED_STAGE_SLUGS, type WorkflowRoute } from "@trock-crm/shared/types";

const SERVICE_ROUTE_THRESHOLD = 50000;
const BID_BOARD_STAGE_SLUG_SET = new Set<string>(BID_BOARD_MIRRORED_STAGE_SLUGS);

export interface LegacyDealStageHistoryEntry {
  fromStageId: string | null;
  toStageId: string;
  changedAt: Date | string | null;
}

export interface PlanDealWorkflowBackfillInput {
  id: string;
  stageSlug?: string | null;
  workflowRoute?: WorkflowRoute | null;
  pipelineTypeSnapshot?: WorkflowRoute | null;
  ddEstimate?: number | string | null;
  bidEstimate?: number | string | null;
  awardedAmount?: number | string | null;
  sourceLeadId?: string | null;
  isBidBoardOwned?: boolean | null;
  bidBoardStageSlug?: string | null;
  bidBoardStageEnteredAt?: Date | string | null;
  bidBoardMirrorSourceEnteredAt?: Date | string | null;
  stageEnteredAt?: Date | string | null;
  isReadOnlyMirror?: boolean | null;
  readOnlySyncedAt?: Date | string | null;
  stageHistory?: LegacyDealStageHistoryEntry[];
}

export interface DealWorkflowBackfillPlan {
  ownershipModel: "crm" | "bid_board";
  isBidBoardOwned: boolean;
  reopenInCrmEditableFlow: boolean;
  mirroredStageSlug: string | null;
  effectiveStageEnteredAt: Date | null;
  pipelineTypeSnapshot: WorkflowRoute;
  preservedStageHistory: LegacyDealStageHistoryEntry[];
  sourceLinkage: {
    sourceLeadId: string | null;
  };
  safetyChecks: string[];
}

export interface DealBidBoardOwnershipInference {
  ownershipModel: "crm" | "bid_board";
  isBidBoardOwned: boolean;
  reopenInCrmEditableFlow: boolean;
  mirroredStageSlug: string | null;
  effectiveStageEnteredAt: Date | null;
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

function parseDate(value: Date | string | null | undefined): Date | null {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeMirroredStageSlug(stageSlug: string | null | undefined) {
  return stageSlug && BID_BOARD_STAGE_SLUG_SET.has(stageSlug) ? stageSlug : null;
}

function resolvePipelineTypeSnapshot(input: PlanDealWorkflowBackfillInput): WorkflowRoute {
  const candidateAmounts = [input.awardedAmount, input.bidEstimate, input.ddEstimate]
    .map(parseNumericValue)
    .filter((value): value is number => value !== null);

  const value = candidateAmounts[0] ?? null;
  if (value !== null) {
    return value < SERVICE_ROUTE_THRESHOLD ? "service" : "normal";
  }

  if (input.pipelineTypeSnapshot === "service" || input.workflowRoute === "service") {
    return "service";
  }

  return "normal";
}

function hasBidBoardSync(input: PlanDealWorkflowBackfillInput) {
  const mirroredStageSlug =
    normalizeMirroredStageSlug(input.bidBoardStageSlug) ?? normalizeMirroredStageSlug(input.stageSlug);

  return Boolean(
    input.isBidBoardOwned ||
      mirroredStageSlug ||
      input.isReadOnlyMirror ||
      input.readOnlySyncedAt ||
      input.bidBoardStageEnteredAt ||
      input.bidBoardMirrorSourceEnteredAt
  );
}

function resolveEffectiveStageEnteredAt(
  input: PlanDealWorkflowBackfillInput,
  isBidBoardOwned: boolean
) {
  if (isBidBoardOwned) {
    return (
      parseDate(input.bidBoardStageEnteredAt) ??
      parseDate(input.bidBoardMirrorSourceEnteredAt) ??
      parseDate(input.stageEnteredAt)
    );
  }

  return parseDate(input.stageEnteredAt);
}

export function inferDealBidBoardOwnership(
  input: PlanDealWorkflowBackfillInput
): DealBidBoardOwnershipInference {
  const mirroredStageSlug =
    normalizeMirroredStageSlug(input.bidBoardStageSlug) ?? normalizeMirroredStageSlug(input.stageSlug);
  const isBidBoardOwned = hasBidBoardSync(input);

  return {
    ownershipModel: isBidBoardOwned ? "bid_board" : "crm",
    isBidBoardOwned,
    reopenInCrmEditableFlow: !isBidBoardOwned,
    mirroredStageSlug: isBidBoardOwned ? mirroredStageSlug : null,
    effectiveStageEnteredAt: resolveEffectiveStageEnteredAt(input, isBidBoardOwned),
  };
}

export function planDealWorkflowBackfill(
  input: PlanDealWorkflowBackfillInput
): DealWorkflowBackfillPlan {
  const ownership = inferDealBidBoardOwnership(input);
  const safetyChecks = new Set<string>();

  if (ownership.isBidBoardOwned) {
    safetyChecks.add("preserve_bid_board_read_only_state");
  }

  if (input.sourceLeadId) {
    safetyChecks.add("preserve_source_lead_linkage");
  }

  if ((input.stageHistory?.length ?? 0) > 0) {
    safetyChecks.add("preserve_stage_history");
  }

  return {
    ownershipModel: ownership.ownershipModel,
    isBidBoardOwned: ownership.isBidBoardOwned,
    reopenInCrmEditableFlow: ownership.reopenInCrmEditableFlow,
    mirroredStageSlug: ownership.mirroredStageSlug,
    effectiveStageEnteredAt: ownership.effectiveStageEnteredAt,
    pipelineTypeSnapshot: resolvePipelineTypeSnapshot(input),
    preservedStageHistory: input.stageHistory ?? [],
    sourceLinkage: {
      sourceLeadId: input.sourceLeadId ?? null,
    },
    safetyChecks: [...safetyChecks],
  };
}
