import crypto from "node:crypto";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { deals, jobQueue, tasks } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { buildAuditActorFromUser, logActivity } from "../audit/audit-logger.js";
import { enqueueRfpBidBoardCreate } from "./rfp-enqueue.js";
import { resolveSyncHubOverrideApproveUrl } from "./rfp-payload.js";
import { loadRfpVoteDetail, type RfpVoteView } from "./rfp-vote-detail.js";
import { buildArchivedDescription } from "./archive-description.js";
import { recordDescriptionHistoryChange } from "./deal-description-history.js";

type TenantDb = NodePgDatabase<typeof schema>;

const SYNCHUB_OVERRIDE_TIMEOUT_MS = 8000;

export interface RfpOverrideActor {
  userId: string;
  name: string;
  role: string;
}

export type RfpOverrideApprovalResult =
  // `unconfirmed` = the POST timed out (the request may have reached SyncHub, but no 202 was seen). The deal is
  // kept 'approving' (NOT made retryable — re-approve would risk a duplicate against a possibly-in-flight first
  // attempt) so a later callback can resolve it; a stuck 'approving' is escapable by re-confirming the denial.
  //
  // `requestId`: the SyncHub rfp_approval_requests.id for the LEGACY (service/type-4) path. On the VOTING path
  // there is no SyncHub request row (rfp_approval_request_id stays null), so `requestId` is the sentinel `0`
  // (the create funnels through create-from-rfp, not SyncHub's override-approve — see requestOverrideApproval).
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
  // `archived` = whether THIS reconfirm soft-deleted the deal. True on the normal path; false for the
  // stuck-approving escape hatch (which upholds the denial but leaves the deal active so an in-flight SyncHub
  // callback can still find it). Consumers (the denial-upheld email + the review-page footer CTA) key off it.
  | { ok: true; status: "declined"; decision: "denial_reconfirmed"; archived: boolean }
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
  /** deals.is_active — false once the deal is archived (a re-confirmed denial). The page hides the "Open the
   *  full deal" link when false, since getDealById 404s inactive deals. */
  isActive: boolean;
  /** The round's recorded votes (voter + choice + reason + time), for the escalation summary. */
  votes: RfpVoteView[];
}

function signBody(rawBody: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

// declined AND not already a re-confirmed denial AND in an allowed override state.
//   - approve (default): state IS NULL OR 'failed'. A re-approve is BLOCKED while 'approving' so a retry can never
//     fire a second Bid Board creation against a first attempt that may still be in flight (duplicate risk); a
//     'failed' override is retryable (the attempt is definitively finished).
//   - reconfirm (allowApproving): also allows 'approving'. Upholding the denial creates NO project, so it's
//     duplicate-safe even mid-flight, and it lets a reviewer escape an 'approving' deal whose callback never
//     arrives (e.g. an unconfirmed POST timeout) instead of being locked out forever.
function overrideActionableConditions(opts: { allowApproving?: boolean } = {}) {
  const allowedStates = opts.allowApproving
    ? or(isNull(deals.rfpOverrideState), eq(deals.rfpOverrideState, "failed"), eq(deals.rfpOverrideState, "approving"))!
    : or(isNull(deals.rfpOverrideState), eq(deals.rfpOverrideState, "failed"))!;
  return [
    eq(deals.rfpApprovalStatus, "declined"),
    allowedStates,
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
    officeId: string | null;
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
      // finding (override BC5): stamp with the transaction's now() (NOT a JS Date). The request-less branch below
      // enqueues rfp_bidboard_create in THIS same transaction with created_at = now() (its column default), and the
      // dead-letter sweep compares that job created_at to rfp_override_reviewed_at. A JS Date is computed
      // mid-transaction and is a few ms LATER than now() (the transaction-start timestamp), so created_at <
      // reviewed_at would make the sweep treat this override's OWN dead job as stale — leaving the review stuck in
      // 'approving' instead of surfacing 'failed'. now() makes reviewed_at EQUAL the job's created_at.
      rfpOverrideReviewedAt: sql`now()`,
      rfpOverrideReviewedBy: input.actor.userId,
      rfpOverrideDecision: "override_approved",
      rfpOverrideNote: input.note,
      updatedAt: new Date(),
    })
    // finding Y7: require is_active=true. A voting-path NO-GO deal soft-deleted before a reviewer opens the
    // override link must NOT enter the request-less create branch below — the bid-board-created callback resolves
    // deals via findDeal (is_active=true), so an external project could be created but never reconciled in CRM.
    // A deleted deal matches 0 rows here -> not_actionable, no create.
    .where(and(eq(deals.id, input.dealId), eq(deals.isActive, true), ...overrideActionableConditions()))
    // Return only what THIS function body reads (truthiness, request id, and the audit name/secondary-id
    // snapshots). The owner columns + round event id are intentionally NOT projected: enqueueRfpBidBoardCreate ->
    // loadRfpPayloadDeal re-fetches every payload field (owner, amounts, address, round event id, …)
    // authoritatively from the DB by id, so the create is robust regardless of how narrow this projection is.
    .returning({
      id: deals.id,
      rfpApprovalRequestId: deals.rfpApprovalRequestId,
      name: deals.name,
      projectNumber: deals.projectNumber,
      dealNumber: deals.dealNumber,
    });

  if (!reset) {
    return { ok: false, reason: "not_actionable" };
  }

  const requestId = reset.rfpApprovalRequestId;

  // VOTING-PATH deals never create a SyncHub request row (rfp_approval_request_id stays null). Their
  // override-approve funnels through the SAME create-from-rfp path as a 2/3-yes vote (enqueueRfpBidBoardCreate),
  // not SyncHub's override-approve (which requires a pre-existing declined request row). One create path, two
  // triggers (vote-yes + override-approve). The 'approving' write persists; the bid-board-created callback
  // advances the deal exactly as the legacy path's callback does.
  if (requestId == null) {
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
      fieldChanges: { rfpOverrideState: { from: priorOverrideState, to: "approving" } },
      metadata: { rfpOverrideAction: "override_approve_via_create_from_rfp", approverEmail: input.approverEmail, rfpOverrideNote: input.note },
    });
    // enqueueRfpBidBoardCreate -> loadRfpPayloadDeal re-fetches the full payload (owner, amounts, address, round
    // event id, …) authoritatively from the DB by id, so passing just the deal id is sufficient (no owner columns
    // or cast needed).
    await enqueueRfpBidBoardCreate({
      tenantDb: input.tenantDb,
      officeId: input.officeId,
      deal: { id: input.dealId },
    });
    // requestId: 0 = the voting-path sentinel (no SyncHub request id exists) — see RfpOverrideApprovalResult.
    return { ok: true, status: "approving", requestId: 0 };
  }

  // LEGACY (service/type-4): a declined deal that ran the SyncHub pipeline always carries the request id.
  if (typeof requestId !== "number" || !Number.isInteger(requestId) || requestId <= 0) {
    // Guard defensively so the route rolls back rather than POSTing to a `/null/override-approve` URL.
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
    // The abort timeout fired. This is genuinely ambiguous: the request was already sent, so SyncHub MAY have
    // received it (a callback will resolve the deal) — but it also may never have left (DNS/TCP/TLS setup, a
    // blackholed host), in which case no callback ever comes. Keep the deal 'approving' (unconfirmed):
    //   - we must NOT make it immediately retryable. A re-approve while the first attempt may still be creating
    //     the Procore project would race it into a DUPLICATE. Re-approve is blocked while 'approving' and only
    //     unlocks after a definitive 'failed' callback (the attempt is then known finished), so we never fire a
    //     second create against a possibly-in-flight first one;
    //   - we must NOT roll back. That would drop rfp_override_reviewed_at (breaking the failed-callback freshness
    //     guard) and re-expose an un-gated one-click approve.
    // Keeping 'approving' preserves rfp_override_reviewed_at so a real in-flight callback still resolves the deal,
    // and the page keeps polling. If no callback ever arrives, the deal is NOT permanently locked: re-confirming
    // the denial is allowed from 'approving' (it creates no project, so it's duplicate-safe) and lets the reviewer
    // escape a stuck attempt.
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
 * re-flagged. Allowed on a fresh declined RFP, after a FAILED override (the reviewers give up), or from an
 * 'approving' deal (it creates no project, so upholding the denial is duplicate-safe even mid-flight — this is
 * the escape hatch for an 'approving' deal whose callback never arrives). Blocked only once already re-confirmed.
 */
/** Best-effort office schema resolver (returns null if it can't) — for the request-less re-confirm email enqueue. */
async function resolveSchemaForOfficeBestEffort(tenantDb: TenantDb, officeId: string | null): Promise<string | null> {
  if (!officeId) return null;
  try {
    const res: any = await tenantDb.execute(sql`SELECT slug FROM public.offices WHERE id = ${officeId} LIMIT 1`);
    const rows = Array.isArray(res) ? res : res.rows ?? [];
    const slug = rows[0]?.slug;
    return typeof slug === "string" && /^[a-z][a-z0-9_]*$/.test(slug) ? `office_${slug}` : null;
  } catch {
    return null;
  }
}

export async function reconfirmRfpDecline(input: {
  tenantDb: TenantDb;
  dealId: string;
  actor: RfpOverrideActor;
  note: string | null;
  // Needed to resolve the tenant schema for the request-less re-confirm email enqueue (finding). Optional so
  // callers that don't notify (or can't) still work — a null officeId just skips the app-side email.
  officeId?: string | null;
}): Promise<RfpReconfirmResult> {
  // Capture the pre-reconfirm override state under a ROW LOCK (FOR UPDATE), BEFORE the guarded update clears it.
  // When the reviewer upholds the denial from the STUCK-APPROVING escape hatch, a SyncHub /bid-board-created
  // callback may still be in flight, and its findDeal lookup filters is_active=true — so we must NOT archive in
  // that case (the late callback has to find the still-active row to no-op idempotently, and a late SUCCESS must
  // not resurrect a denied+archived deal). Normal reconfirms (no approval in flight) auto-archive as designed.
  //
  // The lock is what makes `wasApproving` reflect the UPDATE-time state, not a stale snapshot: this whole route
  // runs in one transaction (req.tenantDb + req.commitTransaction), so the FOR UPDATE lock is held through the
  // guarded update below. A concurrent requestOverrideApproval on the same deal must take the row's write-lock
  // for its own UPDATE, so it serializes against us — it either commits 'approving' before our locked read (we
  // see it → skip archive) or blocks until we commit (its is_active=true + not-reconfirmed guard then matches 0
  // rows → no SyncHub create). Without the lock, an unlocked read could see NULL just before a concurrent approve
  // commits 'approving', then this branch would archive the deal while a Bid Board create is in flight.
  const [preReconfirm] = await input.tenantDb
    .select({ state: deals.rfpOverrideState })
    .from(deals)
    .where(eq(deals.id, input.dealId))
    .limit(1)
    .for("update");
  const wasApproving = preReconfirm?.state === "approving";

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
    .where(and(eq(deals.id, input.dealId), ...overrideActionableConditions({ allowApproving: true })))
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

  // Auto-archive on denial reconfirm (either reviewer): soft-delete the deal and prepend the voter + reviewer
  // notes to the description. Guarded on the current is_active so a redundant call never re-prepends, and skipped
  // for the stuck-approving escape hatch (see wasApproving above) so an in-flight SyncHub callback stays findable.
  // `archived` is the authoritative outcome returned to callers (the email + the review-page CTA both key off it).
  const archived = Boolean(updated.isActive) && !wasApproving;
  if (archived) {
    const reviewerReason = (input.note ?? "").trim();
    const voterNotes = (updated.rfpDeclinedReason ?? "").trim();
    const combined =
      `RFP denied.${voterNotes ? ` ${voterNotes}` : ""} · Final review ` +
      `(${input.actor.name ?? input.actor.userId}): ${reviewerReason}`;
    const archivedDescription = buildArchivedDescription(updated.description, combined, new Date());
    await input.tenantDb.update(deals).set({ isActive: false, description: archivedDescription }).where(eq(deals.id, input.dealId));
    await recordDescriptionHistoryChange(input.tenantDb, {
      dealId: input.dealId,
      oldDescription: updated.description,
      newDescription: archivedDescription,
      changedBy: input.actor.userId,
      source: "rfp_reconfirm_denial",
    });
    await input.tenantDb
      .update(tasks)
      .set({ status: "dismissed", isOverdue: false })
      .where(and(inArray(tasks.dealId, [input.dealId]), inArray(tasks.status, ["pending", "in_progress"])));
    await logActivity({
      tenantDb: input.tenantDb,
      actor: buildAuditActorFromUser({ userId: input.actor.userId, name: input.actor.name, role: input.actor.role }),
      action: "soft_delete",
      entity: {
        tableName: "deals",
        entityType: "deal",
        recordId: input.dealId,
        nameSnapshot: String(updated.name ?? "Deal"),
        secondaryIdSnapshot: (updated.projectNumber ?? updated.dealNumber ?? null) as string | null,
      },
      fieldChanges: { isActive: { from: true, to: false } },
    });
  }

  // finding: the migration 0154 trigger fires the "denial upheld" email on the denial_reconfirmed transition ONLY
  // for request-BACKED deals (it returns early on a NULL rfp_approval_request_id). A VOTING-path no-go that a
  // reviewer re-confirms carries no request id, so the requesting rep + leadership would never be notified.
  // Enqueue the SAME job app-side for that case, keyed on the round event id (the worker uses it for idempotency
  // when there is no request id). Runs only on the real transition (the guarded UPDATE matched), so it's once-only.
  if (updated.rfpApprovalRequestId == null) {
    const schemaName = await resolveSchemaForOfficeBestEffort(input.tenantDb, input.officeId ?? null);
    if (schemaName) {
      await input.tenantDb.insert(jobQueue).values({
        jobType: "rfp_reconfirm_denial_email",
        payload: {
          tenantSchema: schemaName,
          dealId: input.dealId,
          dealNumber: (updated.projectNumber ?? updated.dealNumber ?? null) as string | null,
          dealName: updated.name ?? null,
          declinedReason: updated.rfpDeclinedReason ?? null,
          rfpApprovalRequestId: null,
          rfpVoteRoundId: updated.rfpApprovalRequestEventId ?? null,
          requestedByUserId: updated.rfpApprovalRequestedBy ?? null,
        },
        officeId: null,
        status: "pending",
        runAfter: new Date(),
      });
    }
  }

  return { ok: true, status: "declined", decision: "denial_reconfirmed", archived };
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
           d.rfp_approval_request_event_id AS "roundEventId",
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
           d.rfp_override_error AS "overrideError",
           d.is_active AS "isActive"
      FROM deals d
      LEFT JOIN public.users req ON req.id = d.rfp_approval_requested_by
      LEFT JOIN public.users rev ON rev.id = d.rfp_override_reviewed_by
     WHERE d.id = ${dealId}
     LIMIT 1
  `);
  const rows = (Array.isArray(result) ? result : result.rows ?? []) as Array<Record<string, any>>;
  const row = rows[0];
  if (!row) return null;

  const { rfpVotes } = await loadRfpVoteDetail(tenantDb, dealId, (row.roundEventId as string | null) ?? null);

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
    isActive: row.isActive !== false,
    votes: rfpVotes,
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
