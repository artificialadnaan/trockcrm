import { eq, and, desc, sql, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  deals,
  dealStageHistory,
  dealApprovals,
  jobQueue,
  tasks,
} from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";
import { DOMAIN_EVENTS } from "../../events/types.js";
import { validateStageGate } from "./stage-gate.js";
import type { UserRole } from "@trock-crm/shared/types";
import { createStageTimers } from "./timer-service.js";
import { activateDealScopingIntake, evaluateDealScopingReadiness } from "./scoping-service.js";
import {
  BID_BOARD_STAGE_READ_ONLY_MESSAGE,
  BID_BOARD_BOUNDARY_STAGE_MISSING_MESSAGE,
  getEstimatingBoundaryStage,
  isBidBoardOwnedDownstreamStage,
} from "./service.js";
import { inferDealBidBoardOwnership } from "./workflow-backfill.js";

type TenantDb = NodePgDatabase<typeof schema>;

function isEstimatingBoundaryStageSlug(stageSlug: string, workflowRoute: "normal" | "service") {
  return (
    stageSlug === "estimating" ||
    stageSlug === (workflowRoute === "service" ? "service_estimating" : "estimate_in_progress")
  );
}

function toCanonicalTerminalOutcomeSlug(
  stageSlug: string,
  workflowRoute: "normal" | "service"
): "sent_to_production" | "service_sent_to_production" | "production_lost" | "service_lost" | null {
  if (stageSlug === "sent_to_production" || stageSlug === "service_sent_to_production") {
    return stageSlug;
  }
  if (stageSlug === "production_lost" || stageSlug === "service_lost") {
    return stageSlug;
  }
  if (stageSlug === "closed_won") {
    return workflowRoute === "service" ? "service_sent_to_production" : "sent_to_production";
  }
  if (stageSlug === "closed_lost") {
    return workflowRoute === "service" ? "service_lost" : "production_lost";
  }
  return null;
}

function isLostOutcomeStage(stageSlug: string, workflowRoute: "normal" | "service") {
  const canonicalOutcomeSlug = toCanonicalTerminalOutcomeSlug(stageSlug, workflowRoute);
  return canonicalOutcomeSlug === "production_lost" || canonicalOutcomeSlug === "service_lost";
}

function isWonOutcomeStage(stageSlug: string, workflowRoute: "normal" | "service") {
  const canonicalOutcomeSlug = toCanonicalTerminalOutcomeSlug(stageSlug, workflowRoute);
  return (
    canonicalOutcomeSlug === "sent_to_production" ||
    canonicalOutcomeSlug === "service_sent_to_production"
  );
}

export interface StageChangeInput {
  dealId: string;
  targetStageId: string;
  userId: string;
  userRole: UserRole;
  overrideReason?: string;
  lostReasonId?: string;
  lostNotes?: string;
  lostCompetitor?: string;
}

export interface StageChangeResult {
  deal: typeof deals.$inferSelect;
  stageHistory: typeof dealStageHistory.$inferSelect | null;
  eventsEmitted: string[];
  _eventsToEmit: Array<{ name: string; payload: any }>;
}

export interface ServiceHandoffActivationInput {
  dealId: string;
  userId: string;
  userRole: UserRole;
}

export interface ServiceHandoffActivationResult {
  activated: true;
  eventsEmitted: string[];
  _eventsToEmit: Array<{ name: string; payload: any }>;
}

/**
 * Change a deal's stage with full validation, enforcement, and event emission.
 *
 * Orchestration flow:
 * 1. Validate stage gate requirements
 * 2. Enforce backward move rules
 * 3. Handle terminal stage requirements (Closed Lost, Closed Won)
 * 4. Handle deal reopen (moving from terminal back to active)
 * 5. Update deal record
 * 6. Update stage history record with override metadata
 * 7. Insert durable job_queue entries (outbox pattern)
 * 8. Return events for route handler to emit locally after commit
 */
export async function changeDealStage(
  tenantDb: TenantDb,
  input: StageChangeInput
): Promise<StageChangeResult> {
  const { dealId, targetStageId, userId, userRole, overrideReason, lostReasonId, lostNotes, lostCompetitor } = input;

  // Lock the deal row FOR UPDATE to prevent concurrent stage changes.
  const currentDeal = await tenantDb
    .select()
    .from(deals)
    .where(eq(deals.id, dealId))
    .limit(1)
    .for("update");
  if (currentDeal.length === 0) {
    throw new AppError(404, "Deal not found");
  }

  // Rep ownership check: reps can only modify their own deals.
  // Must happen before the same-stage no-op to prevent probing other reps' deals.
  if (userRole === "rep" && currentDeal[0].assignedRepId !== userId) {
    throw new AppError(403, "You can only modify your own deals");
  }

  // Same-stage no-op: if the deal is already in the target stage, return it unchanged.
  // Do NOT update stageEnteredAt or emit events.
  if (currentDeal[0].stageId === targetStageId) {
    return { deal: currentDeal[0], stageHistory: null, eventsEmitted: [], _eventsToEmit: [] };
  }

  // Step 1: Validate stage gate (includes rep ownership check)
  const gateResult = await validateStageGate(tenantDb, dealId, targetStageId, userRole, userId);

  // Step 2: Enforce rules
  if (!gateResult.allowed) {
    throw new AppError(403, gateResult.blockReason ?? "Stage change not allowed");
  }

  // If override is required, must provide reason
  if (gateResult.requiresOverride && !overrideReason) {
    throw new AppError(400, "Override reason is required for this stage change", "OVERRIDE_REQUIRED");
  }

  const isDirectorOrAdmin = userRole === "director" || userRole === "admin";
  const isDirectorOverride = gateResult.requiresOverride && isDirectorOrAdmin;

  // Step 3: Terminal stage enforcement
  const targetStage = gateResult.targetStage;
  const inferredOwnership = inferDealBidBoardOwnership({
    id: currentDeal[0].id,
    stageSlug: gateResult.currentStage.slug,
    stageEnteredAt: currentDeal[0].stageEnteredAt,
    workflowRoute: currentDeal[0].workflowRoute,
    pipelineTypeSnapshot: currentDeal[0].pipelineTypeSnapshot,
    ddEstimate: currentDeal[0].ddEstimate,
    bidEstimate: currentDeal[0].bidEstimate,
    awardedAmount: currentDeal[0].awardedAmount,
    sourceLeadId: currentDeal[0].sourceLeadId,
    isBidBoardOwned: currentDeal[0].isBidBoardOwned,
    bidBoardStageSlug: currentDeal[0].bidBoardStageSlug,
    bidBoardStageEnteredAt: currentDeal[0].bidBoardStageEnteredAt,
    bidBoardMirrorSourceEnteredAt: currentDeal[0].bidBoardMirrorSourceEnteredAt,
    isReadOnlyMirror: currentDeal[0].isReadOnlyMirror,
    readOnlySyncedAt: currentDeal[0].readOnlySyncedAt,
  });
  const estimatingBoundary = await getEstimatingBoundaryStage(currentDeal[0].workflowRoute);
  if (inferredOwnership.isBidBoardOwned && !estimatingBoundary) {
    throw new AppError(
      500,
      BID_BOARD_BOUNDARY_STAGE_MISSING_MESSAGE,
      "BID_BOARD_BOUNDARY_STAGE_MISSING"
    );
  }

  const currentIsBidBoardBoundaryOrDownstream =
    Boolean(estimatingBoundary) &&
    (isEstimatingBoundaryStageSlug(gateResult.currentStage.slug, currentDeal[0].workflowRoute) ||
      isBidBoardOwnedDownstreamStage(
        gateResult.currentStage,
        estimatingBoundary,
        currentDeal[0].workflowRoute
      ));
  const targetIsBidBoardDownstream =
    Boolean(estimatingBoundary) &&
    isBidBoardOwnedDownstreamStage(targetStage, estimatingBoundary, currentDeal[0].workflowRoute);
  const targetIsReopenIntoCrmOwnedFlow =
    Boolean(estimatingBoundary) &&
    targetStage.displayOrder < (estimatingBoundary?.displayOrder ?? Number.NEGATIVE_INFINITY) &&
    !isEstimatingBoundaryStageSlug(targetStage.slug, currentDeal[0].workflowRoute);

  if (
    (inferredOwnership.isBidBoardOwned || currentIsBidBoardBoundaryOrDownstream) &&
    (currentIsBidBoardBoundaryOrDownstream || targetIsBidBoardDownstream) &&
    !targetIsReopenIntoCrmOwnedFlow
  ) {
    throw new AppError(
      403,
      BID_BOARD_STAGE_READ_ONLY_MESSAGE,
      "BID_BOARD_OWNED_STAGE_READ_ONLY"
    );
  }

  // Closed Lost: require lost_reason_id + lost_notes
  if (isLostOutcomeStage(targetStage.slug, currentDeal[0].workflowRoute)) {
    if (!lostReasonId) {
      throw new AppError(400, "lost_reason_id is required when closing a deal as lost");
    }
    if (!lostNotes || lostNotes.trim().length === 0) {
      throw new AppError(400, "lost_notes is required when closing a deal as lost");
    }
  }

  // Step 4: Handle reopen (moving from terminal to active)
  const currentStage = gateResult.currentStage;
  const isReopen = currentStage.isTerminal && !targetStage.isTerminal;

  // Use the already-locked deal row for duration calculation (no redundant fetch)
  const deal = currentDeal[0];

  // Step 5: Build deal update
  const dealUpdates: Record<string, any> = {
    stageId: targetStageId,
    stageEnteredAt: new Date(),
  };
  const shouldResetBidBoardOwnership =
    inferredOwnership.isBidBoardOwned &&
    Boolean(estimatingBoundary) &&
    targetStage.displayOrder < (estimatingBoundary?.displayOrder ?? Number.NEGATIVE_INFINITY);

  let scopingActivation:
    | Awaited<ReturnType<typeof activateDealScopingIntake>>
    | null = null;
  if (isEstimatingBoundaryStageSlug(targetStage.slug, currentDeal[0].workflowRoute)) {
    // Activate the scoping record while CRM still owns the deal. The ownership
    // boundary flips as part of this same transaction, but the activation path
    // intentionally remains editable only on the CRM-owned side.
    scopingActivation = await activateDealScopingIntake(tenantDb, dealId);
  }

  if (shouldResetBidBoardOwnership) {
    dealUpdates.isBidBoardOwned = false;
    dealUpdates.bidBoardStageSlug = null;
    dealUpdates.bidBoardStageFamily = null;
    dealUpdates.bidBoardStageStatus = null;
    dealUpdates.bidBoardStageEnteredAt = null;
    dealUpdates.bidBoardStageExitedAt = null;
    dealUpdates.bidBoardStageDuration = null;
    dealUpdates.bidBoardLossOutcome = null;
    dealUpdates.bidBoardMirrorSourceEnteredAt = null;
    dealUpdates.bidBoardMirrorSourceExitedAt = null;
    dealUpdates.isReadOnlyMirror = false;
    dealUpdates.isReadOnlySyncDirty = false;
    dealUpdates.readOnlySyncedAt = null;
  }

  if (isEstimatingBoundaryStageSlug(targetStage.slug, currentDeal[0].workflowRoute)) {
    dealUpdates.isBidBoardOwned = true;
    dealUpdates.bidBoardStageSlug = targetStage.slug;
    dealUpdates.readOnlySyncedAt = new Date();
  }

  // Always clear ALL terminal fields before setting new ones.
  // This prevents stale data when moving between terminal stages
  // (e.g., Closed Won -> Closed Lost) or reopening.
  dealUpdates.actualCloseDate = null;
  dealUpdates.lostReasonId = null;
  dealUpdates.lostNotes = null;
  dealUpdates.lostCompetitor = null;
  dealUpdates.lostAt = null;

  // Then set the fields specific to the target terminal stage
  if (isWonOutcomeStage(targetStage.slug, currentDeal[0].workflowRoute)) {
    dealUpdates.actualCloseDate = new Date().toISOString().split("T")[0]; // DATE only
  }

  if (isLostOutcomeStage(targetStage.slug, currentDeal[0].workflowRoute)) {
    dealUpdates.lostReasonId = lostReasonId;
    dealUpdates.lostNotes = lostNotes;
    dealUpdates.lostCompetitor = lostCompetitor ?? null;
    dealUpdates.lostAt = new Date();
  }

  // Reopen handling: invalidate old approvals so they can't be reused
  if (isReopen) {
    await tenantDb.update(dealApprovals)
      .set({ status: "rejected", resolvedAt: new Date(), notes: "Auto-invalidated on deal reopen" })
      .where(and(eq(dealApprovals.dealId, dealId), eq(dealApprovals.status, "approved")));
  }

  // Apply update
  const updatedDealResult = await tenantDb
    .update(deals)
    .set(dealUpdates)
    .where(eq(deals.id, dealId))
    .returning();
  const updatedDeal = updatedDealResult[0];

  // Auto-dismiss pending/in-progress tasks when deal reaches a terminal stage
  if (targetStage.isTerminal) {
    await tenantDb
      .update(tasks)
      .set({ status: "dismissed", isOverdue: false })
      .where(
        and(
          eq(tasks.dealId, dealId),
          inArray(tasks.status, ["pending", "in_progress"]),
        )
      );
  }

  // Step 6: Explicitly insert stage history with all fields.
  // The PG trigger is kept as a safety net for direct SQL updates, but we do
  // the authoritative insert here with override metadata the trigger can't know.

  // Calculate duration in previous stage
  const durationInPreviousStage = deal.stageEnteredAt
    ? `${Math.floor((Date.now() - new Date(deal.stageEnteredAt).getTime()) / 1000)} seconds`
    : null;

  const historyInsertResult = await tenantDb.insert(dealStageHistory).values({
    dealId,
    fromStageId: currentStage.id,
    toStageId: targetStage.id,
    changedBy: userId,
    isBackwardMove: gateResult.isBackwardMove,
    isDirectorOverride: isDirectorOverride ?? false,
    overrideReason: isDirectorOverride ? (overrideReason ?? null) : null,
    durationInPreviousStage,
  }).returning();

  const stageHistoryRecord = historyInsertResult[0] ?? null;

  // Step 7: Outbox pattern -- insert durable jobs into job_queue INSIDE the
  // transaction so they are committed atomically with the deal update +
  // stage history. The worker picks these up independently.
  // All jobs use jobType "domain_event" to match the worker's handler registry.
  const eventsEmitted: string[] = [];
  const eventsToEmit: Array<{ name: string; payload: any }> = [];

  // Build stage changed payload
  const stageChangedPayload = {
    dealId,
    dealName: updatedDeal.name,
    dealNumber: updatedDeal.dealNumber,
    fromStageId: currentStage.id,
    fromStageName: currentStage.name,
    toStageId: targetStage.id,
    toStageName: targetStage.name,
    isBackwardMove: gateResult.isBackwardMove,
    isDirectorOverride,
    changedBy: userId,
  };

  // Always: stage changed
  eventsToEmit.push({ name: DOMAIN_EVENTS.DEAL_STAGE_CHANGED, payload: stageChangedPayload });
  eventsEmitted.push(DOMAIN_EVENTS.DEAL_STAGE_CHANGED);

  // Durable job (inside transaction) — use "domain_event" to match worker handler
  await tenantDb.insert(jobQueue).values({
    jobType: "domain_event",
    payload: { eventName: "deal.stage.changed", ...stageChangedPayload },
    status: "pending",
  });

  if (isEstimatingBoundaryStageSlug(targetStage.slug, updatedDeal.workflowRoute)) {
    const scopingActivatedPayload = {
      dealId,
      dealName: updatedDeal.name,
      dealNumber: updatedDeal.dealNumber,
      workflowRoute: updatedDeal.workflowRoute,
      activatedBy: userId,
      scopingStatus: scopingActivation?.readiness.status ?? "ready",
    };
    eventsToEmit.push({
      name: "scoping_intake.activated",
      payload: scopingActivatedPayload,
    });
    eventsEmitted.push("scoping_intake.activated");
    await tenantDb.insert(jobQueue).values({
      jobType: "domain_event",
      payload: {
        eventName: "scoping_intake.activated",
        ...scopingActivatedPayload,
      },
      status: "pending",
    });
  }

  // Closed Won
  if (isWonOutcomeStage(targetStage.slug, updatedDeal.workflowRoute)) {
    const wonPayload = {
      dealId,
      dealName: updatedDeal.name,
      dealNumber: updatedDeal.dealNumber,
      awardedAmount: updatedDeal.awardedAmount,
      assignedRepId: updatedDeal.assignedRepId,
    };
    eventsToEmit.push({ name: DOMAIN_EVENTS.DEAL_WON, payload: wonPayload });
    eventsEmitted.push(DOMAIN_EVENTS.DEAL_WON);

    await tenantDb.insert(jobQueue).values({
      jobType: "domain_event",
      payload: { eventName: "deal.won", ...wonPayload },
      status: "pending",
    });
  }

  // Closed Lost
  if (isLostOutcomeStage(targetStage.slug, updatedDeal.workflowRoute)) {
    const lostPayload = {
      dealId,
      dealName: updatedDeal.name,
      dealNumber: updatedDeal.dealNumber,
      lostReasonId,
      lostNotes,
      lostCompetitor,
      assignedRepId: updatedDeal.assignedRepId,
    };
    eventsToEmit.push({ name: DOMAIN_EVENTS.DEAL_LOST, payload: lostPayload });
    eventsEmitted.push(DOMAIN_EVENTS.DEAL_LOST);

    await tenantDb.insert(jobQueue).values({
      jobType: "domain_event",
      payload: { eventName: "deal.lost", ...lostPayload },
      status: "pending",
    });
  }

  // Auto-create stage-specific timers (best-effort, inside transaction)
  try {
    await createStageTimers(tenantDb, dealId, targetStage.slug, userId);
  } catch (timerErr) {
    // Non-blocking — log and continue. Stage change must not fail due to timer errors.
    console.error("[StageChange] Failed to create stage timers:", timerErr);
  }

  // Return events for the route handler to emit locally AFTER commitTransaction().
  // The durable jobs in job_queue are already part of this transaction and will
  // be visible to the worker after commit.
  return {
    deal: updatedDeal,
    stageHistory: stageHistoryRecord,
    eventsEmitted,
    _eventsToEmit: eventsToEmit,
  };
}

export async function activateServiceHandoff(
  tenantDb: TenantDb,
  input: ServiceHandoffActivationInput
): Promise<ServiceHandoffActivationResult> {
  const [deal] = await tenantDb
    .select()
    .from(deals)
    .where(eq(deals.id, input.dealId))
    .limit(1);

  if (!deal) {
    throw new AppError(404, "Deal not found");
  }

  if (input.userRole === "rep" && deal.assignedRepId !== input.userId) {
    throw new AppError(403, "You can only modify your own deals");
  }

  if (deal.workflowRoute !== "service") {
    throw new AppError(400, "Deal is not service-routed");
  }

  const readiness = await evaluateDealScopingReadiness(tenantDb, input.dealId);
  if (readiness.status === "draft") {
    throw new AppError(400, "Scoping intake is incomplete. Complete all required scoping items before activating service handoff.");
  }

  const scopingActivation = await activateDealScopingIntake(tenantDb, input.dealId);
  const payload = {
    dealId: deal.id,
    dealName: deal.name,
    dealNumber: deal.dealNumber,
    workflowRoute: deal.workflowRoute,
    activatedBy: input.userId,
    scopingStatus: scopingActivation.readiness.status,
  };

  await tenantDb.insert(jobQueue).values({
    jobType: "domain_event",
      payload: {
      eventName: "scoping_intake.activated",
      ...payload,
    },
    status: "pending",
  });

  return {
    activated: true,
    eventsEmitted: ["scoping_intake.activated"],
    _eventsToEmit: [
      {
        name: "scoping_intake.activated",
        payload,
      },
    ],
  };
}
