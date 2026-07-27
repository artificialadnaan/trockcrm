import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { dealHistory, dealSignedCommissions, deals } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import {
  commissionAckKey,
  evaluateReturnToOpportunityEligibility,
  type ReturnToOpportunityEligibility,
  type UserRole,
  type WorkflowRoute,
} from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import { logActivity, type AuditContext } from "../audit/audit-logger.js";
import { removeCommissionForDeal } from "../commissions/service.js";
import { getStageById, getStageBySlug } from "../pipeline/service.js";
import { effectiveContractSignedDate } from "../shared/won-close-date.js";
import { changeDealStage, type StageChangeResult } from "./stage-change.js";

type TenantDb = NodePgDatabase<typeof schema>;

/** Source tag on the deal_history + audit_log rows this action writes. One string, grepped by ops. */
export const RETURN_TO_OPPORTUNITY_SOURCE = "return_to_opportunity";

export interface ReturnToOpportunityPreview extends ReturnToOpportunityEligibility {
  dealId: string;
  dealName: string;
  currentStageSlug: string | null;
  currentStageName: string | null;
  /** True while the deal is still bound to Bid Board sync (drives the "delete it from Bid Board" copy). */
  isBidBoardLinked: boolean;
  /** Already detached by an earlier move-back; the action is still allowed (it re-runs the reset). */
  bidBoardDetachedAt: string | null;
  procoreCompanyId: string | null;
  procoreBidId: string | null;
  effectiveContractSignedDate: string | null;
}

export interface ReturnToOpportunityInput {
  dealId: string;
  userId: string;
  userRole: UserRole;
  reason: string;
  /**
   * The commission total the CONFIRM DIALOG showed the operator, echoed back. Required whenever the
   * deal actually carries commission rows: if the live sum has moved since the preview (a concurrent
   * recompute, a rate change, a second admin in another tab), we refuse rather than destroy a number
   * nobody agreed to. Not a nicety — this is the only thing standing between "click through a dialog"
   * and "delete a payout the operator never saw".
   */
  acknowledgedCommissionTotal?: string | null;
  auditContext?: AuditContext;
}

export interface ReturnToOpportunityResult {
  deal: typeof deals.$inferSelect;
  stageChange: StageChangeResult;
  /** Rows deleted from deal_signed_commissions (0 for an ordinary pre-Won move). */
  commissionRowsVoided: number;
  commissionTotalVoided: string;
  contractSignedDateCleared: string | null;
  wasBidBoardLinked: boolean;
  _eventsToEmit: Array<{ name: string; payload: unknown }>;
}

/**
 * Every column that binds a deal to Bid Board sync, nulled in one place.
 *
 * The identity columns (procore_bid_id / procore_company_id / synchub_bid_board_id / project_number /
 * deal_number / bid_board_created_at) are DELIBERATELY absent: the SyncHub /opportunities webhook
 * resolves a deal by synchub_bid_board_id then procore_bid_id and, on a miss, INSERTs a brand-new
 * bid-board-owned deal — so wiping identity trades "the sync drags this deal forward" for "the sync
 * creates a twin of it", which is strictly worse. bid_board_detached_at is what stops the sync;
 * identity stays for the audit trail and for the webhook's idempotency lookup.
 *
 * bidBoardLinkedAt + bidBoardProjectNumber ARE cleared even though the existing backward-move reset
 * (shouldResetBidBoardOwnership in stage-change.ts) leaves them: resolveDealScopeLockState locks the
 * deal's scope on either of them, so leaving them behind lands the deal at Opportunity permanently
 * un-editable — the operator could not fix the scope that made it "not ready to progress", which is
 * the entire point of the action.
 */
function buildBidBoardDetachUpdate(userId: string, reason: string, now: Date) {
  return {
    bidBoardDetachedAt: now,
    bidBoardDetachedBy: userId,
    bidBoardDetachReason: reason,
    isBidBoardOwned: false,
    bidBoardStageSlug: null,
    bidBoardStageFamily: null,
    bidBoardStageStatus: null,
    bidBoardStageEnteredAt: null,
    bidBoardStageExitedAt: null,
    bidBoardStageDuration: null,
    bidBoardLossOutcome: null,
    bidBoardMirrorSourceEnteredAt: null,
    bidBoardMirrorSourceExitedAt: null,
    isReadOnlyMirror: false,
    isReadOnlySyncDirty: false,
    readOnlySyncedAt: null,
    bidBoardLinkedAt: null,
    bidBoardProjectNumber: null,
    bidBoardLastUpdatedAt: null,
  } as const;
}

/**
 * The whole RFP cycle, cleared verbatim from cancelPendingRfp's field list (pending-rfp-service.ts).
 * Three independent reasons this is mandatory rather than cosmetic:
 *  1. RE-TRIGGER. POST /:id/trigger-rfp rejects with RFP_ALREADY_TRIGGERED while rfpApprovalRequestedAt
 *     or rfpApprovalStatus is set, and its atomic reservation additionally requires isBidBoardOwned
 *     false + bidBoardStageSlug/readOnlySyncedAt/bidBoardStageEnteredAt/bidBoardMirrorSourceEnteredAt
 *     null + isReadOnlyMirror false — i.e. exactly the detach set above. Miss one and the deal can
 *     never be re-submitted, which defeats the purpose of moving it back.
 *  2. SCOPE-LOCK. resolveDealScopeLockState locks on rfpApprovalRequestedAt or rfpApprovalStatus.
 *  3. RESURRECTION. The internal-RFP bid-board-created callback's `AND rfp_approval_status IS NOT NULL`
 *     guard is what stops a late 'created' from re-approving + re-owning the deal. It only fires if we
 *     null the status.
 */
function buildRfpCycleReset() {
  return {
    rfpApprovalStatus: null,
    rfpApprovalRequestedAt: null,
    rfpApprovalRequestedBy: null,
    rfpApprovalRequestEventId: null,
    rfpApprovalRequestId: null,
    rfpApprovalToken: null,
    rfpDeclinedReason: null,
    rfpDeclinedAt: null,
    rfpConflictReason: null,
    rfpConflictWith: null,
    rfpLastAttemptError: null,
    rfpOverrideState: null,
    rfpOverrideDecision: null,
    rfpOverrideError: null,
    rfpOverrideNote: null,
    rfpOverrideReviewedAt: null,
    rfpOverrideReviewedBy: null,
    rfpBidboardAttemptAt: null,
  } as const;
}

/** Booked commission on a deal: row count + summed amount as a decimal string. */
async function loadCommissionState(tenantDb: TenantDb, dealId: string) {
  const [row] = await tenantDb
    .select({
      rowCount: sql<number>`count(*)::int`,
      total: sql<string>`coalesce(sum(${dealSignedCommissions.amount}), 0)::text`,
    })
    .from(dealSignedCommissions)
    .where(eq(dealSignedCommissions.dealId, dealId));

  return {
    rowCount: Number(row?.rowCount ?? 0),
    total: String(row?.total ?? "0"),
  };
}

/** Active change-order CHILD deals hanging off this deal (they stay Won and keep their own commission). */
async function countActiveChangeOrders(tenantDb: TenantDb, dealId: string) {
  const [row] = await tenantDb
    .select({ rowCount: sql<number>`count(*)::int` })
    .from(deals)
    .where(
      and(
        eq(deals.parentDealId, dealId),
        eq(deals.isChangeOrder, true),
        eq(deals.isActive, true)
      )
    );
  return Number(row?.rowCount ?? 0);
}

async function loadDealOrThrow(tenantDb: TenantDb, dealId: string, forUpdate: boolean) {
  const query = tenantDb.select().from(deals).where(eq(deals.id, dealId)).limit(1);
  const [deal] = forUpdate ? await query.for("update") : await query;
  if (!deal) throw new AppError(404, "Deal not found");
  return deal;
}

async function buildEligibility(
  tenantDb: TenantDb,
  deal: typeof deals.$inferSelect,
  userRole: UserRole
) {
  const currentStage = await getStageById(deal.stageId);
  const commission = await loadCommissionState(tenantDb, deal.id);
  const activeChangeOrderCount = await countActiveChangeOrders(tenantDb, deal.id);
  const signedDate = effectiveContractSignedDate(deal.contractSignedDate, deal.contractSignedAt);

  const eligibility = evaluateReturnToOpportunityEligibility(
    {
      stageSlug: currentStage?.slug ?? null,
      workflowRoute: (deal.workflowRoute ?? "normal") as WorkflowRoute,
      isActive: deal.isActive,
      isChangeOrder: deal.isChangeOrder,
      activeChangeOrderCount,
      commissionRowCount: commission.rowCount,
      commissionTotal: commission.total,
      effectiveContractSignedDate: signedDate,
    },
    userRole
  );

  return { eligibility, currentStage, commission, signedDate };
}

/**
 * Read-only preview backing the confirm dialog. It is the ONLY place the dollar amount shown to the
 * operator comes from, and the amount is echoed back on commit — so this and the commit path must read
 * the same rows (they both call loadCommissionState).
 */
export async function previewReturnToOpportunity(
  tenantDb: TenantDb,
  input: { dealId: string; userRole: UserRole }
): Promise<ReturnToOpportunityPreview> {
  const deal = await loadDealOrThrow(tenantDb, input.dealId, false);
  const { eligibility, currentStage, signedDate } = await buildEligibility(
    tenantDb,
    deal,
    input.userRole
  );

  return {
    ...eligibility,
    dealId: deal.id,
    dealName: deal.name,
    currentStageSlug: currentStage?.slug ?? null,
    currentStageName: currentStage?.name ?? null,
    // "Linked" for dialog purposes means the deal still has a Bid Board footprint the operator has to
    // go delete by hand — an already-detached deal keeps its procore ids, so key on the marker too.
    isBidBoardLinked:
      deal.bidBoardDetachedAt == null &&
      (deal.isBidBoardOwned ||
        deal.procoreBidId != null ||
        deal.bidBoardProjectNumber != null ||
        deal.bidBoardLinkedAt != null),
    bidBoardDetachedAt: deal.bidBoardDetachedAt ? deal.bidBoardDetachedAt.toISOString() : null,
    procoreCompanyId: deal.procoreCompanyId ?? null,
    procoreBidId: deal.procoreBidId != null ? String(deal.procoreBidId) : null,
    effectiveContractSignedDate: signedDate,
  };
}

/**
 * Move a deal back to Opportunity: sever the Bid Board linkage, reset the RFP cycle, void any booked
 * commission, then run the ordinary stage change.
 *
 * ORDER MATTERS. The detach UPDATE runs FIRST so that by the time changeDealStage reads the row,
 * inferDealBidBoardOwnership already reports "crm" and the BID_BOARD_OWNED_STAGE_READ_ONLY guard is
 * trivially satisfied instead of relying on its targetIsReopenIntoCrmOwnedFlow escape hatch. Doing it
 * the other way round would make this action's correctness depend on a guard exemption that exists for
 * a different reason and could be tightened at any time.
 *
 * ATOMICITY. Everything here runs on the caller's transaction (the route's request transaction). A
 * detach that committed without the stage move would leave a deal invisible to Bid Board sync but still
 * sitting in estimating — the worst of both worlds and undetectable without a bespoke query. The stale
 * guards live in the UPDATE's WHERE (id + stage_id + is_active), mirroring cancelPendingRfp, so a
 * concurrent stage change between the read and the write matches nothing and 409s.
 */
export async function returnDealToOpportunity(
  tenantDb: TenantDb,
  input: ReturnToOpportunityInput
): Promise<ReturnToOpportunityResult> {
  const reason = input.reason.trim();
  if (reason.length === 0) {
    throw new AppError(
      400,
      "A reason is required to move a deal back to Opportunity.",
      "MOVE_BACK_REASON_REQUIRED"
    );
  }

  // FOR UPDATE here and again inside changeDealStage; the second lock is a no-op re-acquire on the
  // same transaction and keeps changeDealStage usable standalone.
  const deal = await loadDealOrThrow(tenantDb, input.dealId, true);
  const { eligibility, currentStage, commission, signedDate } = await buildEligibility(
    tenantDb,
    deal,
    input.userRole
  );

  if (!eligibility.allowed) {
    // Role blocks are 403; state blocks (wrong stage / change orders / archived) are 409 — the client
    // distinguishes "you may not" from "not in this state" when deciding whether to re-render.
    const status =
      eligibility.blockCode === "ROLE_NOT_ALLOWED" ||
      eligibility.blockCode === "COMMISSION_ROLE_NOT_ALLOWED"
        ? 403
        : 409;
    throw new AppError(
      status,
      eligibility.blockReason ?? "This deal cannot be moved back to Opportunity.",
      `MOVE_BACK_${eligibility.blockCode ?? "BLOCKED"}`
    );
  }

  // Explicit money confirmation: the caller must echo the exact total the dialog displayed. A mismatch
  // means the number the operator agreed to is no longer the number we would destroy, so refuse and let
  // them re-read it. Only enforced when there is actually money to void.
  if (commission.rowCount > 0) {
    const acknowledged = commissionAckKey(input.acknowledgedCommissionTotal);
    const live = commissionAckKey(commission.total);
    if (input.acknowledgedCommissionTotal == null || acknowledged !== live) {
      throw new AppError(
        409,
        `This deal has ${commission.rowCount} booked commission row(s) totalling ${live}. ` +
          "Re-open the confirmation dialog and confirm that exact amount before moving it back.",
        "MOVE_BACK_COMMISSION_ACK_REQUIRED"
      );
    }
  }

  // No workflow-family filter: pipeline_stage_config.slug is globally UNIQUE and there is exactly one
  // "opportunity" stage (workflow_family = standard_deal). Service-routed deals legitimately sit on it —
  // it is in the shared-canonical set that isStageValidForWorkflowRoute allows for the service route —
  // so filtering by service_deal here would return null and 500 every service deal.
  const opportunityStage = await getStageBySlug("opportunity");
  if (!opportunityStage) {
    throw new AppError(
      500,
      "The Opportunity stage is not configured for this pipeline.",
      "OPPORTUNITY_STAGE_MISSING"
    );
  }

  const now = new Date();
  const wasBidBoardLinked =
    deal.isBidBoardOwned ||
    deal.bidBoardLinkedAt != null ||
    deal.bidBoardProjectNumber != null ||
    deal.readOnlySyncedAt != null;

  // Clearing the contract-signed date alongside the commission void is NOT optional. The Contracts
  // Signed YTD/MTD query (buildRepContractsSignedSql, dashboard/service.ts) has NO stage predicate at
  // all, so a deal that keeps its signed date keeps counting as signed revenue while its commission rows
  // are gone — simultaneously an unqualified opportunity AND booked business. changeDealStage nulls
  // won_closed_date / actual_close_date for us; the signed pair is ours.
  const contractSignedDateCleared = signedDate;

  const detachUpdate = {
    ...buildBidBoardDetachUpdate(input.userId, reason, now),
    ...buildRfpCycleReset(),
    ...(eligibility.voidsCommission
      ? { contractSignedDate: null, contractSignedAt: null }
      : {}),
    updatedAt: now,
  };

  const [detached] = await tenantDb
    .update(deals)
    .set(detachUpdate)
    .where(
      and(
        eq(deals.id, input.dealId),
        eq(deals.isActive, true),
        eq(deals.stageId, deal.stageId),
        eq(deals.isChangeOrder, false)
      )
    )
    .returning({ id: deals.id });

  if (!detached) {
    throw new AppError(
      409,
      "This deal changed while the move was being confirmed; nothing was changed.",
      "MOVE_BACK_STALE"
    );
  }

  // Void booked commission through the SAME audited helper the contract-date clear uses
  // (setDealContractSignedDate's date→null branch). deal_signed_commissions has no soft-delete column
  // — and could not have one, because (deal_id, rep_user_id) is UNIQUE, so a tombstone row would block
  // re-minting if the deal is later re-signed. removeCommissionForDeal writes one audit_log delete row
  // per commission (amount + rep + deal), which IS the void trail; we add a deal-level roll-up below so
  // "what was voided" is answerable from one row rather than N.
  let commissionRowsVoided = 0;
  if (commission.rowCount > 0) {
    commissionRowsVoided = await removeCommissionForDeal(tenantDb, input.dealId, input.userId);
  }

  // Now the ordinary stage change: it owns deal_stage_history (with is_backward_move + the override
  // reason), the terminal-field clear (won_closed_date / actual_close_date / lost_*), the approval
  // invalidation on reopen, the stage timers and the domain events. Deliberately NOT re-implemented
  // here — a second stage-writing path is exactly how deal_stage_history drifts.
  const stageChange = await changeDealStage(tenantDb, {
    dealId: input.dealId,
    targetStageId: opportunityStage.id,
    userId: input.userId,
    userRole: input.userRole,
    // validateStageGate flags this as a backward move and requires an override reason from a
    // director/admin; the operator's typed reason IS that override reason, so it lands on the
    // deal_stage_history row instead of a synthetic string.
    overrideReason: reason,
    auditContext: input.auditContext,
  });

  // Deal-level audit: one row that names who, when, what was severed and exactly how much commission
  // was destroyed. The per-commission delete rows from removeCommissionForDeal are the itemization;
  // this is the header, and it is what an auditor finds by filtering audit_log on the deal.
  if (input.auditContext) {
    await logActivity({
      tenantDb,
      actor: input.auditContext.actor,
      action: "update",
      entity: {
        tableName: "deals",
        entityType: "deal",
        recordId: deal.id,
        nameSnapshot: deal.name,
        secondaryIdSnapshot: deal.projectNumber ?? deal.dealNumber ?? null,
      },
      fieldChanges: {
        stageId: {
          from: currentStage?.name ?? currentStage?.slug ?? deal.stageId,
          to: opportunityStage.name ?? opportunityStage.slug,
        },
        bidBoardDetachedAt: { from: null, to: now.toISOString() },
        isBidBoardOwned: { from: deal.isBidBoardOwned, to: false },
        ...(commissionRowsVoided > 0
          ? { commissionVoidedTotal: { from: commission.total, to: "0" } }
          : {}),
        ...(contractSignedDateCleared && eligibility.voidsCommission
          ? { contractSignedDate: { from: contractSignedDateCleared, to: null } }
          : {}),
      },
      metadata: {
        source: RETURN_TO_OPPORTUNITY_SOURCE,
        reason,
        commissionRowsVoided,
        commissionTotalVoided: commissionRowsVoided > 0 ? commission.total : "0",
        wasBidBoardLinked,
        fromStageSlug: currentStage?.slug ?? null,
      },
      ipAddress: input.auditContext.ipAddress ?? null,
      userAgent: input.auditContext.userAgent ?? null,
    });
  }

  // Timeline row (deal_history) so the deal's History tab explains the move — audit_log does not feed
  // that surface. Mirrors the cancel-rfp escape hatch, which does the same for the same reason.
  await tenantDb.insert(dealHistory).values({
    dealId: deal.id,
    fieldName: "stage_id",
    oldValue: currentStage?.name ?? currentStage?.slug ?? null,
    newValue: opportunityStage.name ?? opportunityStage.slug,
    changedBy: input.userId,
    source: RETURN_TO_OPPORTUNITY_SOURCE,
    reason:
      commissionRowsVoided > 0
        ? `Moved back to Opportunity — ${reason} (disconnected from Bid Board; voided ${commissionRowsVoided} commission row(s) totalling ${commission.total})`
        : `Moved back to Opportunity — ${reason}${wasBidBoardLinked ? " (disconnected from Bid Board)" : ""}`,
    changedAt: now,
  });

  return {
    deal: stageChange.deal,
    stageChange,
    commissionRowsVoided,
    commissionTotalVoided: commissionRowsVoided > 0 ? commission.total : "0",
    contractSignedDateCleared: eligibility.voidsCommission ? contractSignedDateCleared : null,
    wasBidBoardLinked,
    _eventsToEmit: stageChange._eventsToEmit,
  };
}
