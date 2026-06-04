import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { deals } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { insertOpportunityRfpRequestJob } from "./rfp-enqueue.js";
import { buildAuditActorFromUser, logActivity } from "../audit/audit-logger.js";

type TenantDb = NodePgDatabase<typeof schema>;

export interface RfpOverrideActor {
  userId: string;
  name: string;
  role: string;
}

export type RfpResubmitResult =
  | { ok: true; jobId: number; eventId: string; status: "pending_outbox" }
  | { ok: false; reason: "not_actionable" };

export type RfpReconfirmResult =
  | { ok: true; status: "declined"; decision: "denial_reconfirmed" }
  | { ok: false; reason: "not_actionable" };

export interface RfpReviewDetail {
  dealId: string;
  dealName: string;
  dealNumber: string | null;
  projectNumber: string | null;
  rfpApprovalStatus: string | null;
  rfpApprovalRequestId: number | null;
  requestedAt: string | Date | null;
  requestedById: string | null;
  requestedByName: string | null;
  requestedByEmail: string | null;
  declinedReason: string | null;
  declinedAt: string | Date | null;
  reviewedAt: string | Date | null;
  reviewedById: string | null;
  reviewedByName: string | null;
  reviewDecision: string | null;
  reviewNote: string | null;
  /** True only while the deal is freshly declined and not yet second-look-reviewed (i.e. the actions are live). */
  actionable: boolean;
}

/**
 * Approve the override: re-open a DECLINED RFP and re-submit it to SyncHub for a fresh approval cycle.
 *
 * The deal's RFP fields reset to 'pending_outbox' (new request event id, declined-cycle + prior override
 * markers cleared) and an `rfp_request_delivery` job is enqueued via the same machinery as the initial trigger,
 * so the rescue flows through the REAL approval pipeline (SyncHub re-evaluates; a bid-board-created callback
 * then links Procore and advances the deal to estimating). The requesting rep (rfp_approval_requested_by) is
 * intentionally preserved so a re-decline still notifies them.
 *
 * The guarded UPDATE (status='declined' AND not yet reviewed) makes this idempotent: a second call, or a call
 * on an already-approved/re-confirmed deal, matches 0 rows and returns { ok: false } with no enqueue.
 */
export async function resubmitDeclinedRfp(input: {
  tenantDb: TenantDb;
  officeId: string | null;
  dealId: string;
  actor: RfpOverrideActor;
  note: string | null;
}): Promise<RfpResubmitResult> {
  const eventId = randomUUID();
  const [reset] = await input.tenantDb
    .update(deals)
    .set({
      rfpApprovalStatus: "pending_outbox",
      rfpApprovalRequestId: null,
      rfpApprovalToken: null,
      rfpApprovalRequestEventId: eventId,
      rfpApprovalRequestedAt: new Date(),
      rfpDeclinedReason: null,
      rfpDeclinedAt: null,
      rfpLastAttemptError: null,
      rfpConflictReason: null,
      rfpConflictWith: null,
      rfpOverrideReviewedAt: null,
      rfpOverrideReviewedBy: null,
      rfpOverrideDecision: null,
      rfpOverrideNote: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(deals.id, input.dealId),
        eq(deals.rfpApprovalStatus, "declined"),
        isNull(deals.rfpOverrideReviewedAt)
      )
    )
    .returning();

  if (!reset) {
    return { ok: false, reason: "not_actionable" };
  }

  await writeOverrideHistory(input.tenantDb, {
    dealId: input.dealId,
    fieldName: "rfp_approval_status",
    oldValue: "declined",
    newValue: "pending_outbox",
    changedBy: input.actor.userId,
    source: "rfp_override_resubmit",
    reason: input.note,
  });

  await logActivity({
    tenantDb: input.tenantDb,
    actor: buildAuditActorFromUser({ userId: input.actor.userId, name: input.actor.name, role: input.actor.role }),
    action: "update",
    entity: {
      tableName: "deals",
      entityType: "deal",
      recordId: input.dealId,
      nameSnapshot: String(reset.name ?? "Deal"),
      secondaryIdSnapshot: (reset.projectNumber ?? reset.dealNumber ?? null) as string | null,
    },
    // Only the real column change is logged as a field change. The override action itself is recorded in
    // metadata — the reset clears rfp_override_decision back to NULL, so logging it as a field change would be
    // a synthetic/misleading audit entry.
    fieldChanges: {
      rfpApprovalStatus: { from: "declined", to: "pending_outbox" },
    },
    metadata: {
      rfpOverrideAction: "resubmitted_to_synchub",
      rfpOverrideNote: input.note,
      rfpOverrideReviewedBy: input.actor.userId,
      eventId,
    },
  });

  const { jobId } = await insertOpportunityRfpRequestJob({
    tenantDb: input.tenantDb,
    deal: reset,
    officeId: input.officeId,
    eventId,
  });

  return { ok: true, jobId, eventId, status: "pending_outbox" };
}

/**
 * Re-confirm the denial: record that the reviewers looked again and upheld the no-go.
 *
 * Leaves rfp_approval_status = 'declined' untouched (so the decline-email trigger never re-fires) and stamps the
 * rfp_override_* review columns so the deal is not perpetually re-flagged. The same guarded WHERE makes a second
 * review a graceful no-op.
 */
export async function reconfirmRfpDecline(input: {
  tenantDb: TenantDb;
  dealId: string;
  actor: RfpOverrideActor;
  note: string | null;
}): Promise<RfpReconfirmResult> {
  const reviewedAt = new Date();
  const [updated] = await input.tenantDb
    .update(deals)
    .set({
      rfpOverrideReviewedAt: reviewedAt,
      rfpOverrideReviewedBy: input.actor.userId,
      rfpOverrideDecision: "denial_reconfirmed",
      rfpOverrideNote: input.note,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(deals.id, input.dealId),
        eq(deals.rfpApprovalStatus, "declined"),
        isNull(deals.rfpOverrideReviewedAt)
      )
    )
    .returning();

  if (!updated) {
    return { ok: false, reason: "not_actionable" };
  }

  await writeOverrideHistory(input.tenantDb, {
    dealId: input.dealId,
    fieldName: "rfp_override_decision",
    oldValue: null,
    newValue: "denial_reconfirmed",
    changedBy: input.actor.userId,
    source: "rfp_override_reconfirm",
    reason: input.note,
  });

  await logActivity({
    tenantDb: input.tenantDb,
    actor: buildAuditActorFromUser({ userId: input.actor.userId, name: input.actor.name, role: input.actor.role }),
    action: "update",
    entity: {
      tableName: "deals",
      entityType: "deal",
      recordId: input.dealId,
      nameSnapshot: String(updated.name ?? "Deal"),
      secondaryIdSnapshot: (updated.projectNumber ?? updated.dealNumber ?? null) as string | null,
    },
    fieldChanges: {
      rfpOverrideDecision: { from: null, to: "denial_reconfirmed" },
    },
    metadata: { rfpOverrideNote: input.note },
  });

  return { ok: true, status: "declined", decision: "denial_reconfirmed" };
}

/** Page data for the review surface: the declined RFP + requesting rep + any recorded review outcome. */
export async function getRfpReviewDetail(tenantDb: TenantDb, dealId: string): Promise<RfpReviewDetail | null> {
  const result = await tenantDb.execute(sql`
    SELECT d.id AS "dealId",
           d.name AS "dealName",
           d.deal_number AS "dealNumber",
           d.project_number AS "projectNumber",
           d.rfp_approval_status AS "rfpApprovalStatus",
           d.rfp_approval_request_id AS "rfpApprovalRequestId",
           d.rfp_approval_requested_at AS "requestedAt",
           d.rfp_approval_requested_by AS "requestedById",
           req.display_name AS "requestedByName",
           req.email AS "requestedByEmail",
           d.rfp_declined_reason AS "declinedReason",
           d.rfp_declined_at AS "declinedAt",
           d.rfp_override_reviewed_at AS "reviewedAt",
           d.rfp_override_reviewed_by AS "reviewedById",
           rev.display_name AS "reviewedByName",
           d.rfp_override_decision AS "reviewDecision",
           d.rfp_override_note AS "reviewNote"
      FROM deals d
      LEFT JOIN public.users req ON req.id = d.rfp_approval_requested_by
      LEFT JOIN public.users rev ON rev.id = d.rfp_override_reviewed_by
     WHERE d.id = ${dealId}
     LIMIT 1
  `);
  const rows = (Array.isArray(result) ? result : result.rows ?? []) as Array<Record<string, any>>;
  const row = rows[0];
  if (!row) return null;

  return {
    dealId: row.dealId,
    dealName: row.dealName,
    dealNumber: row.dealNumber ?? null,
    projectNumber: row.projectNumber ?? null,
    rfpApprovalStatus: row.rfpApprovalStatus ?? null,
    rfpApprovalRequestId: row.rfpApprovalRequestId ?? null,
    requestedAt: row.requestedAt ?? null,
    requestedById: row.requestedById ?? null,
    requestedByName: row.requestedByName ?? null,
    requestedByEmail: row.requestedByEmail ?? null,
    declinedReason: row.declinedReason ?? null,
    declinedAt: row.declinedAt ?? null,
    reviewedAt: row.reviewedAt ?? null,
    reviewedById: row.reviewedById ?? null,
    reviewedByName: row.reviewedByName ?? null,
    reviewDecision: row.reviewDecision ?? null,
    reviewNote: row.reviewNote ?? null,
    actionable: row.rfpApprovalStatus === "declined" && row.reviewedAt == null,
  };
}

async function writeOverrideHistory(
  tenantDb: TenantDb,
  input: {
    dealId: string;
    fieldName: string;
    oldValue: string | null;
    newValue: string;
    changedBy: string;
    source: string;
    reason: string | null;
  }
): Promise<void> {
  await tenantDb.execute(sql`
    INSERT INTO deal_history (deal_id, field_name, old_value, new_value, changed_by, source, reason, changed_at)
    VALUES (${input.dealId}, ${input.fieldName}, ${input.oldValue}, ${input.newValue}, ${input.changedBy}, ${input.source}, ${input.reason}, NOW())
  `);
}
