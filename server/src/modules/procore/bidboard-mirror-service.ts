import {
  getHoldStateAtStageEntry,
  type WorkflowFamily,
  type WorkflowRoute,
} from "@trock-crm/shared/types";

import { AppError } from "../../middleware/error-handler.js";
import { awardedAmountSeedOnWin } from "../deals/awarded-amount-seed.js";
import {
  VALID_ESTIMATING_SUBSTAGES,
  VALID_PROPOSAL_STATUSES,
  workflowFamilyForRoute,
} from "../deals/service.js";
import {
  effectiveContractSignedDate,
  resolveWonClosedDateWriteThrough,
} from "../shared/won-close-date.js";

export const BID_BOARD_MIRROR_OVERRIDE_REASON = "Bid Board mirror sync";
const VALID_ESTIMATING_SUBSTAGE_SET = new Set<string>(VALID_ESTIMATING_SUBSTAGES);
const VALID_PROPOSAL_STATUS_SET = new Set<string>(VALID_PROPOSAL_STATUSES);
const LEGACY_DEAL_STAGE_TO_CANONICAL_STAGE = {
  normal: {
    dd: "opportunity",
    estimating: "estimating",
    estimate_in_progress: "estimating",
    bid_sent: "estimate_sent_to_client",
    service_estimate_under_review: "estimate_under_review",
    service_estimate_sent_to_client: "estimate_sent_to_client",
    contract_signed: "contract",
    service_contract_signed: "contract",
    in_production: "won",
    close_out: "won",
    sent_to_production: "won",
    service_sent_to_production: "won",
    closed_won: "won",
    production_lost: "lost",
    service_lost: "lost",
    closed_lost: "lost",
  },
  service: {
    dd: "opportunity",
    estimating: "service_estimating",
    estimate_in_progress: "estimating",
    bid_sent: "estimate_sent_to_client",
    service_estimate_under_review: "estimate_under_review",
    service_estimate_sent_to_client: "estimate_sent_to_client",
    contract_signed: "contract",
    service_contract_signed: "contract",
    in_production: "won",
    close_out: "won",
    sent_to_production: "won",
    service_sent_to_production: "won",
    closed_won: "won",
    production_lost: "lost",
    service_lost: "lost",
    closed_lost: "lost",
  },
} as const;

const ROUTE_SPECIFIC_MIRRORED_STAGE_SLUGS = {
  normal: new Set(["estimating"]),
  service: new Set(["service_estimating"]),
} as const;

const SHARED_MIRRORED_STAGE_SLUGS = new Set([
  "opportunity",
  "estimate_under_review",
  "estimate_sent_to_client",
  "contract",
  "won",
  "lost",
]);

const BID_BOARD_STAGE_INPUT_ALIASES = new Map<string, string>([
  ["estimating", "estimating"],
  ["service estimating", "service_estimating"],
  ["estimate under review", "estimate_under_review"],
  ["estimate sent to client", "estimate_sent_to_client"],
  ["contract", "contract"],
  ["won", "won"],
  ["lost", "lost"],
  ["opportunity", "opportunity"],
  ["dd", "opportunity"],
  ["bid sent", "estimate_sent_to_client"],
  ["estimate in progress", "estimating"],
  ["internal review", "estimate_under_review"],
  ["proposal sent", "estimate_sent_to_client"],
  ["sent to production", "won"],
  ["service sent to production", "won"],
  ["closed won", "won"],
  ["service won", "won"],
  ["production lost", "lost"],
  ["service lost", "lost"],
  ["closed lost", "lost"],
  ["deal canceled", "lost"],
]);

type MirrorableDeal = {
  id: string;
  stageId: string;
  stageEnteredAt: Date | string | null;
  onHold?: boolean | null;
  onHoldStartedAt?: Date | string | null;
  onHoldAccumulatedSeconds?: number | null;
  onHoldAccumulatedSecondsAtStageEntry?: number | null;
  workflowRoute: WorkflowRoute;
  isBidBoardOwned: boolean;
  proposalStatus: string | null;
  estimatingSubstage: string | null;
  actualCloseDate: string | null;
  wonClosedDate?: string | null;
  contractSignedDate?: string | null;
  contractSignedAt?: Date | string | null;
  lostReasonId: string | null;
  lostNotes: string | null;
  lostCompetitor: string | null;
  lostAt: Date | string | null;
  bidEstimate?: string | null;
  awardedAmount?: string | null;
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

function normalizeBidBoardStageLookupKey(value: string) {
  return value
    .trim()
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function normalizeBidBoardStageSlug(
  value: string,
  workflowRoute: WorkflowRoute
): string | null {
  const normalizedKey = normalizeBidBoardStageLookupKey(value);
  const mapped = BID_BOARD_STAGE_INPUT_ALIASES.get(normalizedKey);

  if (mapped === "estimating" && workflowRoute === "service") {
    return "service_estimating";
  }

  return mapped ?? null;
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

function toCanonicalMirroredDealStageSlug(
  stageSlug: string,
  workflowRoute: WorkflowRoute
): string | null {
  const normalizedStageSlug = normalizeBidBoardStageSlug(stageSlug, workflowRoute);
  if (normalizedStageSlug) return normalizedStageSlug;

  switch (stageSlug) {
    case "opportunity":
      return stageSlug;
    case "estimating":
      return workflowRoute === "service" ? "service_estimating" : "estimating";
    case "service_estimating":
    case "estimate_under_review":
    case "estimate_sent_to_client":
    case "contract":
    case "won":
    case "lost":
      return stageSlug;
    default:
      return LEGACY_DEAL_STAGE_TO_CANONICAL_STAGE[workflowRoute][
        stageSlug as keyof (typeof LEGACY_DEAL_STAGE_TO_CANONICAL_STAGE)[typeof workflowRoute]
      ] ?? null;
  }
}

function mirroredStageCanBelongToRoute(stageSlug: string, workflowRoute: WorkflowRoute) {
  return (
    SHARED_MIRRORED_STAGE_SLUGS.has(stageSlug) ||
    ROUTE_SPECIFIC_MIRRORED_STAGE_SLUGS[workflowRoute].has(stageSlug)
  );
}

function targetStageCanMirrorRoute(stageSlug: string, workflowRoute: WorkflowRoute) {
  if (stageSlug === "estimating") {
    return workflowRoute === "normal";
  }

  if (stageSlug === "service_estimating") {
    return workflowRoute === "service";
  }

  if (SHARED_MIRRORED_STAGE_SLUGS.has(stageSlug)) {
    return true;
  }

  const canonicalStageSlug = toCanonicalMirroredDealStageSlug(stageSlug, workflowRoute);
  return canonicalStageSlug !== null && mirroredStageCanBelongToRoute(canonicalStageSlug, workflowRoute);
}

function isEstimatingBoundaryCanonicalStage(
  stageSlug: string,
  workflowRoute: WorkflowRoute
) {
  return toCanonicalMirroredDealStageSlug(stageSlug, workflowRoute) ===
    (workflowRoute === "service" ? "service_estimating" : "estimating");
}

function deriveInternalStageFamily(input: {
  stageSlug: string;
  stageStatus: string | null;
  proposalStatus: string | null;
  workflowRoute: WorkflowRoute;
}) {
  const canonicalStageSlug = toCanonicalMirroredDealStageSlug(
    input.stageSlug,
    input.workflowRoute
  );

  switch (canonicalStageSlug) {
    case "estimating":
    case "service_estimating":
    case "estimate_under_review":
      return "estimating";
    case "estimate_sent_to_client":
      return "proposal";
    case "contract":
      return "contract";
    case "won":
      return "terminal_won";
    case "lost":
      return "terminal_loss";
    default:
      return "downstream";
  }
}

function defaultStageFamilyForSlug(stageSlug: string, workflowRoute: WorkflowRoute) {
  const canonicalStageSlug = toCanonicalMirroredDealStageSlug(stageSlug, workflowRoute);

  switch (canonicalStageSlug) {
    case "estimating":
    case "service_estimating":
    case "estimate_under_review":
      return "estimating";
    case "estimate_sent_to_client":
      return "proposal";
    case "contract":
      return "contract";
    case "won":
      return "terminal_won";
    case "lost":
      return "terminal_loss";
    default:
      return "downstream";
  }
}

function stageFamilyMatchesDerived(payloadStageFamily: string, derivedStageFamily: string) {
  if (payloadStageFamily === derivedStageFamily) {
    return true;
  }

  return derivedStageFamily === "terminal_won" && payloadStageFamily === "production";
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

  if (
    input.targetStage.workflowFamily !== sourceOfTruthFamily &&
    !targetStageCanMirrorRoute(input.targetStage.slug, input.deal.workflowRoute)
  ) {
    throw new AppError(400, "Bid Board mirror stage family mismatch");
  }

  const stageStatus = normalizeOptionalText(input.payload.stageStatus);
  const estimatingSubstage =
    normalizeOptionalText(input.payload.estimatingSubstage) ??
    (stageStatus && VALID_ESTIMATING_SUBSTAGE_SET.has(stageStatus) ? stageStatus : null);
  const proposalStatus =
    normalizeOptionalText(input.payload.proposalStatus) ??
    (stageStatus && VALID_PROPOSAL_STATUS_SET.has(stageStatus) ? stageStatus : null);
  const hasProposalStatusPayload = Object.prototype.hasOwnProperty.call(
    input.payload,
    "proposalStatus"
  );
  const derivedStageFamily =
    deriveInternalStageFamily({
      stageSlug: input.targetStage.slug,
      stageStatus,
      proposalStatus,
      workflowRoute: input.deal.workflowRoute,
  }) ?? defaultStageFamilyForSlug(input.targetStage.slug, input.deal.workflowRoute);
  const payloadStageFamily = normalizeOptionalText(input.payload.stageFamily);
  if (payloadStageFamily && !stageFamilyMatchesDerived(payloadStageFamily, derivedStageFamily)) {
    throw new AppError(400, "Bid Board mirror stage family mismatch");
  }

  const stageFamily = derivedStageFamily;
  const canonicalTargetStageSlug =
    toCanonicalMirroredDealStageSlug(input.targetStage.slug, input.deal.workflowRoute) ??
    toCanonicalMirroredDealStageSlug(input.payload.stageSlug, input.deal.workflowRoute);
  const payloadStageEnteredAt = parseOptionalDate(input.payload.stageEnteredAt);
  const stageChanged = input.deal.stageId !== input.targetStage.id;
  const stageEnteredAt =
    stageChanged
      ? payloadStageEnteredAt ?? now
      : parseOptionalDate(input.deal.stageEnteredAt) ?? now;
  const stageExitedAt = parseOptionalDate(input.payload.stageExitedAt);
  const mirrorSourceEnteredAt = parseOptionalDate(input.payload.mirrorSourceEnteredAt);
  const mirrorSourceExitedAt = parseOptionalDate(input.payload.mirrorSourceExitedAt);
  const isBackwardMove =
    stageChanged &&
    input.currentStage != null &&
    input.targetStage.displayOrder < input.currentStage.displayOrder;

  const updates: Record<string, unknown> = {
    stageId: input.targetStage.id,
    stageEnteredAt,
    isBidBoardOwned: true,
    bidBoardStageSlug: canonicalTargetStageSlug ?? input.payload.stageSlug,
    bidBoardStageFamily: stageFamily,
    bidBoardStageStatus: stageStatus,
    bidBoardStageEnteredAt: stageEnteredAt,
    bidBoardStageExitedAt: stageExitedAt,
    bidBoardMirrorSourceEnteredAt: mirrorSourceEnteredAt,
    bidBoardMirrorSourceExitedAt: mirrorSourceExitedAt,
    readOnlySyncedAt: now,
    updatedAt: now,
  };
  if (stageChanged) {
    Object.assign(updates, getHoldStateAtStageEntry(input.deal, stageEnteredAt));
  }

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
    canonicalTargetStageSlug &&
    !["contract", "won", "lost"].includes(canonicalTargetStageSlug)
      ? estimatingSubstage
      : null;
  if (stageFamily === "proposal") {
    if (proposalStatus) {
      updates.proposalStatus = proposalStatus;
    }
  } else if (hasProposalStatusPayload) {
    updates.proposalStatus = proposalStatus;
  }

  updates.actualCloseDate = null;
  updates.wonClosedDate = null; // app-owned Won-period reporting basis (0141): track actual_close_date
  updates.lostReasonId = null;
  updates.lostNotes = null;
  updates.lostCompetitor = null;
  updates.lostAt = null;
  updates.bidBoardLossOutcome = null;

  if (canonicalTargetStageSlug === "won") {
    updates.actualCloseDate = now.toISOString().split("T")[0] ?? null;
    // Dual-write the app-owned Won-period reporting basis (0141). The Bid-Board mirror
    // is the dominant won-path; after the read flip a bid-board-won deal with NULL
    // won_closed_date would silently drop from the Won card. INITIALIZE the column ONLY
    // on a genuine fresh Won entry; otherwise PRESERVE the existing value (incl. NULL,
    // which the backfill later fills from the hs basis -- a safer source than the
    // internal stage_entered_at, which migration 0074 may have repaired to a 2026
    // timestamp). A genuine fresh entry is: (a) a brand-new insert (deal.id === "new",
    // which is structurally stageChanged === false because the synthetic deal seeds
    // stageId = targetStage.id), or (b) a real transition INTO won from a non-won stage.
    // A same-stage Won status/replay webhook (stageChanged false, previous stage won)
    // is NEITHER, so it must not re-stamp. The clear above (~428) nulls it on any
    // non-won update, so reopen -> re-win re-stamps correctly.
    const previousCanonicalStageSlug = input.currentStage
      ? toCanonicalMirroredDealStageSlug(input.currentStage.slug, input.deal.workflowRoute)
      : null;
    const enteringWonFresh =
      input.deal.id === "new" ||
      (stageChanged && previousCanonicalStageSlug !== "won");
    const sourceWonDate = stageEnteredAt.toISOString().split("T")[0] ?? null;
    const stageDrivenWonDate = enteringWonFresh
      ? input.deal.wonClosedDate ?? sourceWonDate
      : input.deal.wonClosedDate ?? null;
    // WRITE-THROUGH (always-when-present): a contract-signed date on this Won deal is
    // accounting's authoritative correction and wins over the Procore stage-entry-derived
    // won date; else the existing fresh-stamp / preserve logic stands. Every Won read surface
    // inherits this through the stored won_closed_date column.
    updates.wonClosedDate = resolveWonClosedDateWriteThrough({
      contractSignedDate: effectiveContractSignedDate(
        input.deal.contractSignedDate,
        input.deal.contractSignedAt
      ),
      stageDrivenWonDate,
    });

    // Seed awarded_amount from the bid estimate on Won, only-if-empty (CRM-internal).
    // Resolve the values as they will be persisted: a payload-provided value (staged into
    // `updates` above) wins ONLY when it is a real, non-blank value; a missing/null/empty
    // staged value falls back to the loaded DB value. This matters because the persist SQL is
    // COALESCE(updates.awardedAmount, awarded_amount): without the non-blank check, an explicit
    // `awardedAmount: null` in the webhook would make resolvedAwarded null, fire the seed, and
    // OVERWRITE a present DB awarded value with the bid. Falling back to the DB value keeps the
    // seed strictly only-if-empty.
    const stagedAwarded = updates.awardedAmount;
    const stagedBid = updates.bidEstimate;
    const resolvedAwarded =
      stagedAwarded != null && String(stagedAwarded).trim() !== ""
        ? stagedAwarded
        : input.deal.awardedAmount;
    const resolvedBid =
      stagedBid != null && String(stagedBid).trim() !== ""
        ? stagedBid
        : input.deal.bidEstimate;
    const awardedSeed = awardedAmountSeedOnWin(
      resolvedAwarded as string | null | undefined,
      resolvedBid as string | null | undefined
    );
    if (awardedSeed !== null) {
      updates.awardedAmount = awardedSeed; // final SQL: COALESCE(updates.awardedAmount, awarded_amount)
    }
  }

  if (canonicalTargetStageSlug === "lost") {
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
          durationInPreviousStage: durationSince(input.deal.stageEnteredAt, stageEnteredAt),
        }
      : null,
  };
}
