import type { WorkflowFamily, WorkflowRoute } from "@trock-crm/shared/types";

import { AppError } from "../../middleware/error-handler.js";
import {
  VALID_ESTIMATING_SUBSTAGES,
  VALID_PROPOSAL_STATUSES,
  workflowFamilyForRoute,
} from "../deals/service.js";

export const BID_BOARD_MIRROR_OVERRIDE_REASON = "Bid Board mirror sync";
const VALID_ESTIMATING_SUBSTAGE_SET = new Set<string>(VALID_ESTIMATING_SUBSTAGES);
const VALID_PROPOSAL_STATUS_SET = new Set<string>(VALID_PROPOSAL_STATUSES);

type MirrorableDeal = {
  id: string;
  stageId: string;
  stageEnteredAt: Date | string | null;
  workflowRoute: WorkflowRoute;
  isBidBoardOwned: boolean;
  proposalStatus: string | null;
  estimatingSubstage: string | null;
  actualCloseDate: string | null;
  lostReasonId: string | null;
  lostNotes: string | null;
  lostCompetitor: string | null;
  lostAt: Date | string | null;
};

type MirrorableStage = {
  id: string;
  slug: string;
  name: string;
  displayOrder: number;
  isTerminal: boolean;
  workflowFamily: WorkflowFamily;
};

export interface BidBoardMirrorPayload {
  stageSlug: string;
  stageStatus?: string | null;
  stageFamily?: string | null;
  estimatingSubstage?: string | null;
  proposalStatus?: string | null;
  stageEnteredAt?: Date | string | null;
  stageExitedAt?: Date | string | null;
  mirrorSourceEnteredAt?: Date | string | null;
  mirrorSourceExitedAt?: Date | string | null;
  ddEstimate?: string | null;
  bidEstimate?: string | null;
  awardedAmount?: string | null;
  proposalNotes?: string | null;
  lostReasonId?: string | null;
  lostNotes?: string | null;
  lostCompetitor?: string | null;
  lossOutcome?: string | null;
}

export interface BidBoardMirrorUpdateResult {
  bypassStageGate: true;
  stageChanged: boolean;
  updates: Record<string, unknown>;
  history: {
    fromStageId: string;
    toStageId: string;
    isBackwardMove: boolean;
    overrideReason: string;
    durationInPreviousStage: string | null;
  } | null;
}

function normalizeOptionalText(value: string | null | undefined) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function parseOptionalDate(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function durationSince(value: Date | string | null, now: Date) {
  const start = parseOptionalDate(value);
  if (!start) {
    return null;
  }

  const seconds = Math.max(0, Math.floor((now.getTime() - start.getTime()) / 1000));
  return `${seconds} seconds`;
}

function deriveInternalStageFamily(input: {
  stageSlug: string;
  stageStatus: string | null;
  proposalStatus: string | null;
}) {
  const reviewSignal = input.proposalStatus ?? input.stageStatus;

  if (
    input.stageSlug === "estimate_sent_to_client" &&
    (reviewSignal === "under_review" ||
      reviewSignal === "accepted" ||
      reviewSignal === "signed")
  ) {
    return "contract_review";
  }

  switch (input.stageSlug) {
    case "estimate_in_progress":
    case "service_estimating":
      return "estimating";
    case "estimate_under_review":
    case "service_estimate_under_review":
      return "review";
    case "estimate_sent_to_client":
    case "service_estimate_sent_to_client":
      return "proposal";
    case "sent_to_production":
    case "service_sent_to_production":
      return "production";
    case "production_lost":
    case "service_lost":
      return "terminal_loss";
    default:
      return "downstream";
  }
}

function defaultStageFamilyForSlug(stageSlug: string) {
  switch (stageSlug) {
    case "estimate_in_progress":
    case "service_estimating":
      return "estimating";
    case "estimate_under_review":
    case "service_estimate_under_review":
      return "review";
    case "estimate_sent_to_client":
    case "service_estimate_sent_to_client":
      return "proposal";
    case "sent_to_production":
    case "service_sent_to_production":
      return "production";
    case "production_lost":
    case "service_lost":
      return "terminal_loss";
    default:
      return "downstream";
  }
}

export function buildBidBoardMirrorUpdate(input: {
  now?: Date;
  deal: MirrorableDeal;
  currentStage?: Pick<MirrorableStage, "id" | "displayOrder" | "slug"> | null;
  targetStage: MirrorableStage;
  payload: BidBoardMirrorPayload;
}): BidBoardMirrorUpdateResult {
  const now = input.now ?? new Date();
  const sourceOfTruthFamily = workflowFamilyForRoute(input.deal.workflowRoute);

  if (input.targetStage.workflowFamily !== sourceOfTruthFamily) {
    throw new AppError(400, "Bid Board mirror stage family mismatch");
  }

  const stageStatus = normalizeOptionalText(input.payload.stageStatus);
  const estimatingSubstage =
    normalizeOptionalText(input.payload.estimatingSubstage) ??
    (stageStatus && VALID_ESTIMATING_SUBSTAGE_SET.has(stageStatus) ? stageStatus : null);
  const proposalStatus =
    normalizeOptionalText(input.payload.proposalStatus) ??
    (stageStatus && VALID_PROPOSAL_STATUS_SET.has(stageStatus) ? stageStatus : null);
  const derivedStageFamily =
    deriveInternalStageFamily({
      stageSlug: input.targetStage.slug,
      stageStatus,
      proposalStatus,
    }) ?? defaultStageFamilyForSlug(input.targetStage.slug);
  const payloadStageFamily = normalizeOptionalText(input.payload.stageFamily);
  if (payloadStageFamily && payloadStageFamily !== derivedStageFamily) {
    throw new AppError(400, "Bid Board mirror stage family mismatch");
  }

  const stageFamily = derivedStageFamily;
  const payloadStageEnteredAt = parseOptionalDate(input.payload.stageEnteredAt);
  const stageEnteredAt =
    payloadStageEnteredAt ?? parseOptionalDate(input.deal.stageEnteredAt) ?? now;
  const stageExitedAt = parseOptionalDate(input.payload.stageExitedAt);
  const mirrorSourceEnteredAt = parseOptionalDate(input.payload.mirrorSourceEnteredAt);
  const mirrorSourceExitedAt = parseOptionalDate(input.payload.mirrorSourceExitedAt);
  const stageChanged = input.deal.stageId !== input.targetStage.id;
  const isBackwardMove =
    stageChanged &&
    input.currentStage != null &&
    input.targetStage.displayOrder < input.currentStage.displayOrder;

  const updates: Record<string, unknown> = {
    stageId: input.targetStage.id,
    stageEnteredAt,
    isBidBoardOwned: true,
    bidBoardStageSlug: input.payload.stageSlug,
    bidBoardStageFamily: stageFamily,
    bidBoardStageStatus: stageStatus,
    bidBoardStageEnteredAt: stageEnteredAt,
    bidBoardStageExitedAt: stageExitedAt,
    bidBoardMirrorSourceEnteredAt: mirrorSourceEnteredAt,
    bidBoardMirrorSourceExitedAt: mirrorSourceExitedAt,
    readOnlySyncedAt: now,
    updatedAt: now,
  };

  if (input.payload.ddEstimate !== undefined) {
    updates.ddEstimate = input.payload.ddEstimate;
  }
  if (input.payload.bidEstimate !== undefined) {
    updates.bidEstimate = input.payload.bidEstimate;
  }
  if (input.payload.awardedAmount !== undefined) {
    updates.awardedAmount = input.payload.awardedAmount;
  }
  if (input.payload.proposalNotes !== undefined) {
    updates.proposalNotes = input.payload.proposalNotes;
  }

  updates.estimatingSubstage =
    [
      "estimate_in_progress",
      "service_estimating",
      "estimate_under_review",
      "estimate_sent_to_client",
      "service_estimate_under_review",
      "service_estimate_sent_to_client",
    ].includes(
      input.targetStage.slug
    )
      ? estimatingSubstage
      : null;
  if (proposalStatus) {
    updates.proposalStatus = proposalStatus;
  }

  updates.actualCloseDate = null;
  updates.lostReasonId = null;
  updates.lostNotes = null;
  updates.lostCompetitor = null;
  updates.lostAt = null;
  updates.bidBoardLossOutcome = null;

  if (
    input.targetStage.slug === "sent_to_production" ||
    input.targetStage.slug === "service_sent_to_production"
  ) {
    updates.actualCloseDate = now.toISOString().split("T")[0] ?? null;
  }

  if (
    input.targetStage.slug === "production_lost" ||
    input.targetStage.slug === "service_lost"
  ) {
    updates.lostReasonId = input.payload.lostReasonId ?? null;
    updates.lostNotes = input.payload.lostNotes ?? null;
    updates.lostCompetitor = input.payload.lostCompetitor ?? null;
    updates.lostAt = now;
    updates.bidBoardLossOutcome = normalizeOptionalText(input.payload.lossOutcome ?? stageStatus);
  }

  return {
    bypassStageGate: true,
    stageChanged,
    updates,
    history: stageChanged
      ? {
          fromStageId: input.deal.stageId,
          toStageId: input.targetStage.id,
          isBackwardMove,
          overrideReason: BID_BOARD_MIRROR_OVERRIDE_REASON,
          durationInPreviousStage: payloadStageEnteredAt
            ? durationSince(input.deal.stageEnteredAt, payloadStageEnteredAt)
            : null,
        }
      : null,
  };
}
