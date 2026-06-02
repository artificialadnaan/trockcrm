import { eq, and, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  deals,
  dealStageHistory,
  dealApprovals,
  jobQueue,
  tasks,
} from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { getHoldStateAtStageEntry, isGenuineWonDealStageSlug } from "@trock-crm/shared/types";
import {
  effectiveContractSignedDate,
  resolveWonClosedDateWriteThrough,
} from "../shared/won-close-date.js";
import { AppError } from "../../middleware/error-handler.js";
import { DOMAIN_EVENTS } from "../../events/types.js";
import {
  isContractStageSelectionEnabled,
} from "../../config/feature-flags.js";
import { validateStageGate, isStageRequiredFieldSatisfied } from "./stage-gate.js";
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
import { logActivity, type AuditContext } from "../audit/audit-logger.js";
import { assertActiveDealStageWriteTarget } from "./stage-write-guard.js";

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
):
  | "sent_to_production"
  | "service_sent_to_production"
  | "production_lost"
  | "service_lost"
  | "won"
  | "lost"
  | null {
  if (stageSlug === "won" || stageSlug === "lost") {
    return stageSlug;
  }
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
  return (
    canonicalOutcomeSlug === "production_lost" ||
    canonicalOutcomeSlug === "service_lost" ||
    canonicalOutcomeSlug === "lost"
  );
}

function isWonOutcomeStage(stageSlug: string, workflowRoute: "normal" | "service") {
  const canonicalOutcomeSlug = toCanonicalTerminalOutcomeSlug(stageSlug, workflowRoute);
  return (
    canonicalOutcomeSlug === "sent_to_production" ||
    canonicalOutcomeSlug === "service_sent_to_production" ||
    canonicalOutcomeSlug === "won"
  );
}

export interface StageChangeInput {
  dealId: string;
  targetStageId: string;
  userId: string;
  userRole: UserRole;
  officeId?: string;
  overrideReason?: string;
  lostReasonId?: string;
  lostNotes?: string;
  lostCompetitor?: string;
  // Optional expected_close_date set in the same stage-change request (the inline stage-advance
  // prompt). Applied with the move and considered by the gate as a pending value so the advance
  // into a stage that requires it succeeds in one action.
  expectedCloseDate?: string | null;
  auditContext?: AuditContext;
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
  const { dealId, targetStageId, userId, userRole, officeId, overrideReason, lostReasonId, lostNotes, lostCompetitor } = input;

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

  // Step 1: Validate stage gate (includes rep ownership check). If the request carries an
  // expectedCloseDate (the inline stage-advance prompt), pass it as a pending value so the gate is
  // satisfied by the date we are about to persist below.
  const pendingFieldValues =
    input.expectedCloseDate !== undefined ? { expectedCloseDate: input.expectedCloseDate || null } : {};
  const gateResult = await validateStageGate(tenantDb, dealId, targetStageId, userRole, userId, pendingFieldValues);
  assertActiveDealStageWriteTarget(gateResult.targetStage);

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
  if (targetStage.slug === "contract" && !isContractStageSelectionEnabled()) {
    throw new AppError(
      403,
      "Contract stage selection is disabled.",
      "CONTRACT_STAGE_SELECTION_DISABLED"
    );
  }

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
  const stageChangedAt = new Date();

  // Step 5: Build deal update
  const dealUpdates: Record<string, any> = {
    stageId: targetStageId,
    stageEnteredAt: stageChangedAt,
  };
  Object.assign(dealUpdates, getHoldStateAtStageEntry(deal, stageChangedAt));
  // Conservative guard: only treat expectedCloseDate as persistable when the target stage's gate
  // checklist actually lists it as a required field. If the requirement can't be confirmed, don't
  // persist (fail-safe) -- so an unrelated stage move can never overwrite the forecast date.
  const targetRequiresExpectedCloseDate = (gateResult.effectiveChecklist?.fields ?? []).some(
    (checklistField) => checklistField.key === "expectedCloseDate"
  );
  // Captured only when the inline date is actually persisted below, so the audit trail records the
  // forecast change next to the stage move (NULL when the inline path doesn't touch the date).
  let expectedCloseDateAuditChange: { from: string | null; to: string | null } | null = null;
  if (
    input.expectedCloseDate !== undefined &&
    targetRequiresExpectedCloseDate &&
    isStageRequiredFieldSatisfied("expectedCloseDate", input.expectedCloseDate)
  ) {
    // Persist the date captured by the inline stage-advance prompt -- but ONLY when the target stage
    // actually requires expectedCloseDate and the supplied value is itself usable (today-or-future).
    // This stops an unrelated stage move (or a stale/empty payload) from overwriting or clearing a
    // deal's forecast date through this path; other forecast edits go via the deal-update endpoint.
    dealUpdates.expectedCloseDate = input.expectedCloseDate;
    const previousExpectedCloseDate = deal.expectedCloseDate ?? null;
    const nextExpectedCloseDate = input.expectedCloseDate ?? null;
    // Mirror the normal deal-update audit path, which skips unchanged fields: only record the change
    // when the value actually moved (never a no-op {from: X, to: X} entry).
    if (previousExpectedCloseDate !== nextExpectedCloseDate) {
      expectedCloseDateAuditChange = { from: previousExpectedCloseDate, to: nextExpectedCloseDate };
    }
  }
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
  dealUpdates.wonClosedDate = null; // app-owned Won-period reporting date (0141): cleared on any terminal change / reopen
  dealUpdates.lostReasonId = null;
  dealUpdates.lostNotes = null;
  dealUpdates.lostCompetitor = null;
  dealUpdates.lostAt = null;

  // Then set the fields specific to the target terminal stage
  if (isWonOutcomeStage(targetStage.slug, currentDeal[0].workflowRoute)) {
    dealUpdates.actualCloseDate = new Date().toISOString().split("T")[0]; // DATE only
    // Dual-write the app-owned Won-period reporting basis (0141) -- a dedicated column
    // the sync/reseed paths never mass-stamp. Stamp today ONLY when entering Won from a
    // non-Won stage; on a move BETWEEN Won stages PRESERVE the existing value verbatim,
    // including NULL (a NULL means "no usable date -> excluded"; the backfill fills it
    // from the hs basis later -- never fabricate today, which would shift an already-won
    // deal into the current reporting period). The "already won" test uses the
    // reporting-aligned isGenuineWonDealStageSlug (which recognizes the legacy service
    // Won stages service_scheduled / service_complete that toCanonicalTerminalOutcomeSlug
    // -- still used for the target / event gating above -- does not).
    const alreadyWon = isGenuineWonDealStageSlug(
      gateResult.currentStage.slug,
      currentDeal[0].workflowRoute
    );
    const stageDrivenWonDate = alreadyWon
      ? currentDeal[0].wonClosedDate
      : new Date().toISOString().split("T")[0];
    // WRITE-THROUGH (always-when-present): if this Won-family deal carries a contract-signed
    // date (accounting's authoritative correction), it wins over the stage-driven stamp; else
    // the stage-driven date (preserved-when-already-Won / today-on-fresh-entry) stands. Every
    // Won read surface inherits this via the stored won_closed_date column.
    dealUpdates.wonClosedDate = resolveWonClosedDateWriteThrough({
      contractSignedDate: effectiveContractSignedDate(
        currentDeal[0].contractSignedDate,
        currentDeal[0].contractSignedAt
      ),
      stageDrivenWonDate,
    });
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

  // Tell the deal_stage_history backstop trigger (migration 0143) to stand down for this
  // transaction: we record a richer history row explicitly below, so the trigger must not
  // also record one. Transaction-local (set_config local=true); cleared after the insert.
  await tenantDb.execute(sql`select set_config('app.skip_stage_history_trigger', '1', true)`);

  // Apply update
  const updatedDealResult = await tenantDb
    .update(deals)
    .set(dealUpdates)
    .where(eq(deals.id, dealId))
    .returning();
  const updatedDeal = updatedDealResult[0];

  if (input.auditContext) {
    await logActivity({
      tenantDb,
      actor: input.auditContext.actor,
      action: "update",
      entity: {
        tableName: "deals",
        entityType: "deal",
        recordId: updatedDeal.id,
        nameSnapshot: updatedDeal.name,
        secondaryIdSnapshot: updatedDeal.projectNumber ?? updatedDeal.dealNumber ?? null,
      },
      fieldChanges: {
        stageId: {
          from: currentStage.name ?? currentStage.slug,
          to: targetStage.name ?? targetStage.slug,
        },
        // Record the inline forecast-date change too, mirroring the normal deal-update audit path, so a
        // close-date set/change made during a stage advance isn't invisible in the trail.
        ...(expectedCloseDateAuditChange ? { expectedCloseDate: expectedCloseDateAuditChange } : {}),
      },
      metadata: {
        overrideReason: overrideReason ?? null,
        lostReasonId: lostReasonId ?? null,
        lostNotes: lostNotes ?? null,
        lostCompetitor: lostCompetitor ?? null,
      },
      ipAddress: input.auditContext.ipAddress ?? null,
      userAgent: input.auditContext.userAgent ?? null,
    });
  }

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

  // Re-arm the backstop trigger for any later stage write in this same transaction.
  await tenantDb.execute(sql`select set_config('app.skip_stage_history_trigger', '', true)`);

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
