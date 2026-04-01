import { eq, desc, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  deals,
  dealStageHistory,
  jobQueue,
} from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";
import { eventBus } from "../../events/bus.js";
import { DOMAIN_EVENTS } from "../../events/types.js";
import { validateStageGate } from "./stage-gate.js";
import type { UserRole } from "@trock-crm/shared/types";

type TenantDb = NodePgDatabase<typeof schema>;

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

  // Same-stage no-op: if the deal is already in the target stage, return it unchanged.
  // Do NOT update stageEnteredAt or emit events.
  const currentDeal = await tenantDb
    .select()
    .from(deals)
    .where(eq(deals.id, dealId))
    .limit(1);
  if (currentDeal.length === 0) {
    throw new AppError(404, "Deal not found");
  }
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

  // Closed Lost: require lost_reason_id + lost_notes
  if (targetStage.slug === "closed_lost") {
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

  // Fetch existing deal for duration calculation
  const existingDeal = await tenantDb
    .select()
    .from(deals)
    .where(eq(deals.id, dealId))
    .limit(1);
  if (existingDeal.length === 0) {
    throw new AppError(404, "Deal not found");
  }
  const deal = existingDeal[0];

  // Step 5: Build deal update
  const dealUpdates: Record<string, any> = {
    stageId: targetStageId,
    stageEnteredAt: new Date(),
  };

  // Closed Won handling
  if (targetStage.slug === "closed_won") {
    dealUpdates.actualCloseDate = new Date().toISOString().split("T")[0]; // DATE only
  }

  // Closed Lost handling
  if (targetStage.slug === "closed_lost") {
    dealUpdates.lostReasonId = lostReasonId;
    dealUpdates.lostNotes = lostNotes;
    dealUpdates.lostCompetitor = lostCompetitor ?? null;
    dealUpdates.lostAt = new Date();
  }

  // Reopen handling: clear terminal-stage fields
  if (isReopen) {
    dealUpdates.actualCloseDate = null;
    dealUpdates.lostReasonId = null;
    dealUpdates.lostNotes = null;
    dealUpdates.lostCompetitor = null;
    dealUpdates.lostAt = null;
  }

  // Apply update
  const updatedDealResult = await tenantDb
    .update(deals)
    .set(dealUpdates)
    .where(eq(deals.id, dealId))
    .returning();
  const updatedDeal = updatedDealResult[0];

  // Step 6: Update the trigger-inserted stage history record with override context.
  // The PG trigger on deals.stage_id fires AFTER UPDATE and inserts a basic record.
  // We find the most recent history record for this deal and update it with the
  // override metadata that the trigger cannot know about.

  // Calculate duration in previous stage
  const durationInPreviousStage = deal.stageEnteredAt
    ? `${Math.floor((Date.now() - new Date(deal.stageEnteredAt).getTime()) / 1000)} seconds`
    : null;

  // Update the most recent history record with override context using Drizzle sql template
  const historyUpdateResult = await tenantDb.execute(sql`
    UPDATE deal_stage_history
    SET is_backward_move = ${gateResult.isBackwardMove},
        is_director_override = ${isDirectorOverride ?? false},
        override_reason = ${isDirectorOverride ? (overrideReason ?? null) : null},
        changed_by = ${userId},
        duration_in_previous_stage = ${durationInPreviousStage}::interval
    WHERE id = (
      SELECT id FROM deal_stage_history
      WHERE deal_id = ${dealId}
      ORDER BY created_at DESC
      LIMIT 1
    )
    RETURNING *
  `);

  const stageHistoryRecord = (historyUpdateResult as any).rows?.[0] ?? null;

  // Step 7: Outbox pattern -- insert durable jobs into job_queue INSIDE the
  // transaction so they are committed atomically with the deal update +
  // stage history. The worker picks these up independently.
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

  // Durable job (inside transaction)
  await tenantDb.insert(jobQueue).values({
    jobType: "deal.stage.changed",
    payload: stageChangedPayload,
    status: "pending",
  });

  // Closed Won
  if (targetStage.slug === "closed_won") {
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
      jobType: "deal.won",
      payload: wonPayload,
      status: "pending",
    });
  }

  // Closed Lost
  if (targetStage.slug === "closed_lost") {
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
      jobType: "deal.lost",
      payload: lostPayload,
      status: "pending",
    });
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
