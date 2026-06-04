import crypto from "node:crypto";
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { deals } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { buildAuditActorFromUser, logActivity } from "../audit/audit-logger.js";
import { resolveSyncHubOverrideApproveUrl } from "./rfp-payload.js";

type TenantDb = NodePgDatabase<typeof schema>;

const SYNCHUB_OVERRIDE_TIMEOUT_MS = 8000;

export interface RfpOverrideActor {
  userId: string;
  name: string;
  role: string;
}

export type RfpOverrideApprovalResult =
  // `unconfirmed` = the POST timed out (the request likely reached SyncHub but no 202 was seen); the deal is kept
  // in 'approving' so a later callback can still resolve it (see the AbortError branch).
  | { ok: true; status: "approving"; requestId: number; unconfirmed?: boolean }
  | { ok: false; reason: "not_actionable" }
  | { ok: false; reason: "missing_request_id" }
  | { ok: false; reason: "synchub_rejected"; syncHubStatus: number; message: string }
  | { ok: false; reason: "synchub_unavailable"; message: string };

export interface RfpOverrideApprovalDeps {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

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
  /** Override-approval delivery state: null | 'approving' (SyncHub creating the project) | 'failed' (retryable). */
  overrideState: string | null;
  overrideError: string | null;
  /** True when a reviewer can act now: declined, not currently approving, and not already a re-confirmed denial. */
  actionable: boolean;
}

function signBody(rawBody: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

// declined AND not currently approving AND not already a re-confirmed denial. (state IS NULL OR 'failed' so a
// failed override is retryable; a re-confirmed denial is terminal; an in-flight 'approving' is locked.)
function overrideActionableConditions() {
  return [
    eq(deals.rfpApprovalStatus, "declined"),
    or(isNull(deals.rfpOverrideState), eq(deals.rfpOverrideState, "failed"))!,
    or(isNull(deals.rfpOverrideDecision), ne(deals.rfpOverrideDecision, "denial_reconfirmed"))!,
  ];
}

/**
 * Approve the override → trigger SyncHub's authoritative Bid Board project creation.
 *
 * The deal is parked in rfp_override_state='approving' (still rfp_approval_status='declined') and the CRM POSTs
 * an HMAC-signed override-approve to SyncHub, which runs the Playwright project creation asynchronously (202).
 * SyncHub later posts a bid-board-created callback — status 'created' (→ linked + advanced to estimating +
 * state cleared) or 'failed' (→ rfp_override_state='failed', retryable). The original requesting rep
 * (rfp_approval_requested_by) is untouched.
 *
 * Returns a discriminated result; on any { ok: false } the calling route throws so the tenant transaction rolls
 * back (the 'approving' write is undone and the deal stays declined + retryable). Idempotent: a second click,
 * or a click while approving / after a re-confirmed denial, matches 0 rows → not_actionable, no SyncHub call.
 */
export async function requestOverrideApproval(
  input: {
    tenantDb: TenantDb;
    dealId: string;
    actor: RfpOverrideActor;
    approverEmail: string;
    note: string | null;
  },
  deps: RfpOverrideApprovalDeps = {}
): Promise<RfpOverrideApprovalResult> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  // Capture the prior override state so the audit records the real transition (null -> approving on a first
  // approval, 'failed' -> approving on a retry) rather than a hard-coded null.
  const [prior] = await input.tenantDb
    .select({ state: deals.rfpOverrideState })
    .from(deals)
    .where(eq(deals.id, input.dealId))
    .limit(1);
  const priorOverrideState = prior?.state ?? null;

  const [reset] = await input.tenantDb
    .update(deals)
    .set({
      rfpOverrideState: "approving",
      rfpOverrideError: null,
      rfpOverrideReviewedAt: new Date(),
      rfpOverrideReviewedBy: input.actor.userId,
      rfpOverrideDecision: "override_approved",
      rfpOverrideNote: input.note,
      updatedAt: new Date(),
    })
    .where(and(eq(deals.id, input.dealId), ...overrideActionableConditions()))
    .returning();

  if (!reset) {
    return { ok: false, reason: "not_actionable" };
  }

  const requestId = reset.rfpApprovalRequestId;
  if (typeof requestId !== "number" || !Number.isInteger(requestId) || requestId <= 0) {
    // Declined deals that ran the pipeline always carry the SyncHub request id; guard defensively so the route
    // rolls back rather than POSTing to a `/null/override-approve` URL.
    return { ok: false, reason: "missing_request_id" };
  }

  await writeOverrideHistory(input.tenantDb, {
    dealId: input.dealId,
    fieldName: "rfp_override_state",
    oldValue: priorOverrideState,
    newValue: "approving",
    changedBy: input.actor.userId,
    source: "rfp_override_approve",
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
    fieldChanges: {
      rfpOverrideState: { from: priorOverrideState, to: "approving" },
    },
    metadata: {
      rfpOverrideAction: "override_approve_requested",
      approverEmail: input.approverEmail,
      rfpApprovalRequestId: requestId,
      rfpOverrideNote: input.note,
    },
  });

  const secret = env.SYNCHUB_SHARED_SECRET;
  if (!secret) {
    return { ok: false, reason: "synchub_unavailable", message: "SYNCHUB_SHARED_SECRET is not configured" };
  }

  const url = resolveSyncHubOverrideApproveUrl(requestId, env);
  const rawBody = JSON.stringify({ approverEmail: input.approverEmail });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNCHUB_OVERRIDE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-rfp-request-signature": signBody(rawBody, secret),
      },
      body: rawBody,
      signal: controller.signal,
    });
  } catch (err) {
    // The abort timeout fired: the request was already sent, so SyncHub may have received it and will emit a
    // callback. Rolling back here would drop rfp_override_reviewed_at (breaking the failed-callback freshness
    // guard) and re-expose a one-click approve that risks a duplicate Procore project. Keep the deal 'approving'
    // (unconfirmed) so a later callback resolves it; the page keeps polling. A definitive connection error (the
    // request never left) stays a clean rollback so the reviewer can retry safely.
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: true, status: "approving", requestId, unconfirmed: true };
    }
    return {
      ok: false,
      reason: "synchub_unavailable",
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }

  // 202 = accepted (a concurrent duplicate also returns 202 per the contract — both mean "creation in flight").
  if (response.status === 202) {
    return { ok: true, status: "approving", requestId };
  }

  let message = `SyncHub returned ${response.status}`;
  try {
    const body = (await response.json()) as { message?: unknown; error?: unknown };
    if (typeof body?.message === "string") message = body.message;
    else if (typeof body?.error === "string") message = body.error;
  } catch {
    /* non-JSON body; keep the status message */
  }
  return { ok: false, reason: "synchub_rejected", syncHubStatus: response.status, message };
}

/**
 * Re-confirm the denial: the reviewers looked again and upheld the no-go.
 *
 * Leaves rfp_approval_status = 'declined' (so the decline-email trigger never re-fires), clears any prior
 * override-approval state, and records decision='denial_reconfirmed' so the decline is not perpetually
 * re-flagged. Allowed on a fresh declined RFP or after a FAILED override (the reviewers give up); blocked
 * while an override is in flight ('approving') or once already re-confirmed.
 */
export async function reconfirmRfpDecline(input: {
  tenantDb: TenantDb;
  dealId: string;
  actor: RfpOverrideActor;
  note: string | null;
}): Promise<RfpReconfirmResult> {
  const [updated] = await input.tenantDb
    .update(deals)
    .set({
      rfpOverrideReviewedAt: new Date(),
      rfpOverrideReviewedBy: input.actor.userId,
      rfpOverrideDecision: "denial_reconfirmed",
      rfpOverrideNote: input.note,
      rfpOverrideState: null,
      rfpOverrideError: null,
      updatedAt: new Date(),
    })
    .where(and(eq(deals.id, input.dealId), ...overrideActionableConditions()))
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

/** Page data for the review surface: the declined RFP + requesting rep + recorded review outcome + override state. */
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
           d.rfp_override_note AS "reviewNote",
           d.rfp_override_state AS "overrideState",
           d.rfp_override_error AS "overrideError"
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
    overrideState: row.overrideState ?? null,
    overrideError: row.overrideError ?? null,
    actionable:
      row.rfpApprovalStatus === "declined" &&
      row.overrideState !== "approving" &&
      row.reviewDecision !== "denial_reconfirmed",
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
