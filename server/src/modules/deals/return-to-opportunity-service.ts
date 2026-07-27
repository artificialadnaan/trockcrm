import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  dealChangeOrders,
  dealHistory,
  dealSignedCommissions,
  deals,
} from "@trock-crm/shared/schema";
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
import { lockDealCommissions } from "../commissions/deal-commission-lock.js";
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
  /**
   * The ROW COUNT the dialog showed alongside the total ("$26,250.00 across 2 rows"), echoed back.
   * Required whenever the deal carries commission, for the same reason as the total: a total on its own
   * does not pin the SET being destroyed. Commission can be re-attributed between preview and submit —
   * an additive estimator/sales-source mint landing while an in-place recompute lowers another row can
   * leave the sum unchanged while the rows underneath it are different — and the operator confirmed
   * both numbers, so both are checked.
   */
  acknowledgedCommissionRowCount?: number | null;
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
function buildBidBoardDetachUpdate(
  userId: string,
  reason: string,
  now: Date,
  wasBidBoardLinked: boolean
) {
  return {
    bidBoardDetachedAt: now,
    bidBoardDetachedBy: userId,
    bidBoardDetachReason: reason,
    // PERSIST the linkage answer — it cannot be recovered afterwards. The four columns immediately
    // below (is_bid_board_owned, bid_board_project_number, bid_board_linked_at, read_only_synced_at)
    // are half of what makes a deal "linked", and this update clears every one of them; the preserved
    // procore/synchub identity is not a stand-in, because most Bid Board linked deals in prod carry
    // neither. Without this the standing "delete the project from the Bid Board" reminder would
    // disappear on reload for exactly the deals that most need it.
    bidBoardDetachedWasLinked: wasBidBoardLinked,
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

/**
 * Sum a locked set of commission rows into the SAME string shape `sum(amount)::text` produces for a
 * numeric(14,2) column ("26250.00", or "0" for an empty set), so the locked and unlocked reads are
 * interchangeable everywhere the total is displayed, acknowledged or audited. Summed in integer CENTS:
 * a long book of rows added as floats can drift a cent, and this number is compared for equality
 * against what the operator confirmed.
 */
function sumCommissionAmounts(rows: Array<{ amount: string | null }>): string {
  if (rows.length === 0) return "0";
  const cents = rows.reduce((acc, row) => acc + Math.round(Number(row.amount ?? 0) * 100), 0);
  return (cents / 100).toFixed(2);
}

/**
 * Booked commission on a deal: row count + summed amount as a decimal string.
 *
 * `forUpdate` is the difference between the read-only PREVIEW and the COMMIT path, and it is a money
 * guarantee rather than an optimization. The parent deal's FOR UPDATE does NOT serialize commission
 * writers: recalculateCommissionForDeal (the settings-driven cross-office recompute, which is
 * fire-and-forget and can be in flight for many seconds after a rate edit) reads and UPDATEs
 * deal_signed_commissions in place without ever locking or writing the deals row. Without a lock here,
 * that recompute can commit between this aggregate read and removeCommissionForDeal below — so the
 * operator confirms $X and the transaction destroys $Y, recording $X in the audit trail. Locking the
 * rows we counted, and holding the lock through the DELETE in the same transaction, makes the confirmed
 * set and the voided set provably identical (see the row-count assertion at the delete site for the one
 * residual case row locks cannot cover: a brand-new INSERT).
 */
async function loadCommissionState(
  tenantDb: TenantDb,
  dealId: string,
  opts: { forUpdate?: boolean } = {}
) {
  if (opts.forUpdate) {
    // ORDER BY id so two concurrent move-backs on the same deal take the row locks in the same order
    // and queue instead of deadlocking.
    const rows = await tenantDb
      .select({ id: dealSignedCommissions.id, amount: dealSignedCommissions.amount })
      .from(dealSignedCommissions)
      .where(eq(dealSignedCommissions.dealId, dealId))
      .orderBy(dealSignedCommissions.id)
      .for("update");

    return { rowCount: rows.length, total: sumCommissionAmounts(rows) };
  }

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

/**
 * Does this deal still carry a Bid Board footprint the operator has to go delete BY HAND?
 *
 * ONE predicate, called by the preview (which renders "you must delete this project from Bid Board
 * yourself") and by the commit path (which records `wasBidBoardLinked` in the audit_log header and the
 * deal_history reason). Two copies drifted before: the preview counted procore_bid_id, the audit flag
 * did not, so a legacy deal whose only footprint is the deliberately PRESERVED procore identity was
 * told to go delete the project while the audit trail recorded that nothing was disconnected.
 *
 * The identity columns count precisely BECAUSE the detach preserves them — they are what the operator
 * follows to the Bid Board project, so they are also what makes the disconnection worth recording. An
 * already-detached deal returns false from both callers: the action is still allowed (it re-runs the
 * reset), but it is not severing a live link.
 */
function isDealBidBoardLinked(deal: typeof deals.$inferSelect): boolean {
  if (deal.bidBoardDetachedAt != null) return false;
  return (
    deal.isBidBoardOwned ||
    deal.procoreBidId != null ||
    deal.synchubBidBoardId != null ||
    deal.bidBoardProjectNumber != null ||
    deal.bidBoardLinkedAt != null ||
    deal.readOnlySyncedAt != null
  );
}

/**
 * The "(disconnected from Bid Board; voided N row(s) totalling $X)" tail on the deal_history reason.
 * Each clause appears only when it actually happened, so the timeline never claims a disconnection or a
 * void that did not occur.
 */
function buildHistoryQualifier(
  wasBidBoardLinked: boolean,
  commissionRowsVoided: number,
  commissionTotal: string
): string {
  const parts: string[] = [];
  if (wasBidBoardLinked) parts.push("disconnected from Bid Board");
  if (commissionRowsVoided > 0) {
    parts.push(`voided ${commissionRowsVoided} commission row(s) totalling ${commissionTotal}`);
  }
  return parts.length > 0 ? ` (${parts.join("; ")})` : "";
}

/**
 * Change orders that must block the parent's move back, counted the SAME way the rest of the app counts
 * them — `listDealChangeOrders` / `getDealChangeOrdersTotal` both UNION the two representations:
 *  • active change-order CHILD deals (the current model — Won, with their own commission rows), and
 *  • un-migrated legacy `deal_change_orders` rows (value-only, no backing deal).
 *
 * Counting only children would let a deal with a legacy row through, clearing the parent's Won/signed
 * state while a change order still contributes to its contract value — precisely the state the
 * HAS_CHANGE_ORDERS block exists to prevent. Prod is currently 0 legacy rows in all three office schemas
 * and there is no INSERT path left into that table (`addDealChangeOrder` creates a child deal), so this
 * arm is defence-in-depth rather than load-bearing — but a destructive action should not be the one
 * place whose definition of "has change orders" is narrower than every read surface.
 */
async function countActiveChangeOrders(tenantDb: TenantDb, dealId: string) {
  const [childRow] = await tenantDb
    .select({ rowCount: sql<number>`count(*)::int` })
    .from(deals)
    .where(
      and(
        eq(deals.parentDealId, dealId),
        eq(deals.isChangeOrder, true),
        eq(deals.isActive, true)
      )
    );
  const [legacyRow] = await tenantDb
    .select({ rowCount: sql<number>`count(*)::int` })
    .from(dealChangeOrders)
    .where(eq(dealChangeOrders.dealId, dealId));

  return Number(childRow?.rowCount ?? 0) + Number(legacyRow?.rowCount ?? 0);
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
  userRole: UserRole,
  opts: { lockCommissions?: boolean } = {}
) {
  const currentStage = await getStageById(deal.stageId);
  const commission = await loadCommissionState(tenantDb, deal.id, {
    forUpdate: opts.lockCommissions,
  });
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
    isBidBoardLinked: isDealBidBoardLinked(deal),
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

  // FIRST statement of the transaction, before ANY row lock — see deal-commission-lock.ts for why the
  // order is load-bearing. This closes the one commission writer the row locks below cannot reach: the
  // settings-driven recompute's sales-source mint, which decides from an unlocked read of the deal and
  // then INSERTs, so without this it can add a row AFTER the delete and leave booked commission on a
  // deal the operator was told had been voided.
  await lockDealCommissions(tenantDb, input.dealId);

  // FOR UPDATE here and again inside changeDealStage; the second lock is a no-op re-acquire on the
  // same transaction and keeps changeDealStage usable standalone.
  const deal = await loadDealOrThrow(tenantDb, input.dealId, true);
  // lockCommissions: the deal's commission rows are locked FOR UPDATE as part of this same read, and
  // the lock is held until this transaction ends — through the acknowledgement check and through the
  // DELETE. The deal-row lock above does NOT cover them (the settings-driven recompute rewrites
  // deal_signed_commissions without touching deals), and this is the read whose total the operator's
  // acknowledgement is compared against.
  const { eligibility, currentStage, commission, signedDate } = await buildEligibility(
    tenantDb,
    deal,
    input.userRole,
    { lockCommissions: true }
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
  // them re-read it. Only enforced when there is actually money to void. Validated against the LOCKED
  // read above, so between this check and the DELETE the amounts cannot move under us.
  if (commission.rowCount > 0) {
    const acknowledged = commissionAckKey(input.acknowledgedCommissionTotal);
    const live = commissionAckKey(commission.total);
    // BOTH numbers the dialog displayed, not just the money. A total on its own does not pin the set:
    // an additive estimator / sales-source mint landing while an in-place recompute lowers another row
    // can hold the sum steady while the rows underneath it change, and "2 rows" is as much a part of
    // what the operator agreed to destroy as "$26,250.00".
    const rowCountAcknowledged =
      input.acknowledgedCommissionRowCount != null &&
      Number(input.acknowledgedCommissionRowCount) === commission.rowCount;
    if (input.acknowledgedCommissionTotal == null || acknowledged !== live || !rowCountAcknowledged) {
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
  // Same predicate the preview used to tell the operator "go delete this from the Bid Board", so the
  // audit trail can never disagree with the instruction the operator was given.
  const wasBidBoardLinked = isDealBidBoardLinked(deal);

  // Clearing the contract-signed date alongside the commission void is NOT optional. The Contracts
  // Signed YTD/MTD query (buildRepContractsSignedSql, dashboard/service.ts) has NO stage predicate at
  // all, so a deal that keeps its signed date keeps counting as signed revenue while its commission rows
  // are gone — simultaneously an unqualified opportunity AND booked business. changeDealStage nulls
  // won_closed_date / actual_close_date for us; the signed pair is ours.
  const contractSignedDateCleared = signedDate;

  const detachUpdate = {
    ...buildBidBoardDetachUpdate(input.userId, reason, now, wasBidBoardLinked),
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
  //
  // Runs UNCONDITIONALLY — including when the locked read found no rows — because it is also the
  // SERIALIZATION POINT for the one drift a row lock cannot cover. Rows we read are locked, so no
  // concurrent transaction can change or remove them; what row locks cannot stop is a brand-new INSERT
  // (mintSalesSourceCommissionForDeal / calculateCommissionForDeal insert without locking the deal
  // row). A deal-scoped DELETE sweeps such a row up, and the count comparison below turns "we destroyed
  // an amount the operator never confirmed" into a 409 that rolls this whole transaction back —
  // including the detach and the stage move — so nothing is destroyed and nothing is half-applied.
  const commissionRowsVoided = await removeCommissionForDeal(tenantDb, input.dealId, input.userId);
  if (commissionRowsVoided !== commission.rowCount) {
    throw new AppError(
      409,
      `This deal's commission changed while the move was being confirmed ` +
        `(${commission.rowCount} row(s) totalling ${commission.total} were confirmed, ` +
        `${commissionRowsVoided} found at commit). Nothing was changed — re-open the confirmation ` +
        "dialog and confirm the current amount.",
      "MOVE_BACK_COMMISSION_CHANGED"
    );
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
    // Both halves of the parenthetical are conditional on what actually happened. A legacy deal can
    // carry commission without ever having been Bid Board linked, so the disconnection phrase is gated
    // on wasBidBoardLinked in EVERY branch — a timeline row that claims a disconnection that did not
    // happen is exactly the kind of drift this row exists to prevent.
    reason: `Moved back to Opportunity — ${reason}${buildHistoryQualifier(
      wasBidBoardLinked,
      commissionRowsVoided,
      commission.total
    )}`,
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
