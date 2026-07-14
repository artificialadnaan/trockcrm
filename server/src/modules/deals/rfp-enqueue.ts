import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { deals, files, jobQueue, users } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { resolveRfpVoterEmails } from "@trock-crm/shared/lib/rfpVoterEmails";
import { PROJECT_TYPE_OPTIONS, resolveDealDisplayNumber, type RfpVoteInvitationDealSummary } from "@trock-crm/shared/types";
import { isOpportunityRfpEventEnabled } from "../../config/feature-flags.js";
import {
  generateDownloadUrl,
  generateMockDownloadUrl,
  isR2Configured,
} from "../../lib/r2-client.js";
import { activeLatestFileConditions, buildDealFileScopeCondition } from "../files/service.js";
import { buildNormalizedRfpRequestBody, buildRfpAttachmentsFromFiles, buildRfpRequestDeliveryPayload, resolveSyncHubCreateFromRfpUrl, resolveSyncHubRfpRequestUrl } from "./rfp-payload.js";

type TenantDb = NodePgDatabase<typeof schema>;

// Presigned download URLs are minted here at enqueue time and persisted inside
// the job_queue payload. The delivery job retries for ~2.7h and SyncHub may
// store/display the link to a human reviewer later, so we mint long-lived URLs
// (7 days — the SigV4 presigned maximum) rather than the default 1h.
const RFP_ATTACHMENT_URL_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface EnqueueOpportunityRfpInput {
  tenantDb: TenantDb;
  deal: typeof deals.$inferSelect;
  userId: string;
  officeId: string | null;
  transitioningFrom?: string | null;
  enteredAt: Date;
}

export interface EnqueueOpportunityRfpResult {
  enqueued: boolean;
  reason?: "feature_disabled" | "already_requested" | "not_opportunity";
  eventId?: string;
  jobId?: number;
  dealUpdates?: Partial<typeof deals.$inferSelect>;
}

export interface InsertOpportunityRfpJobInput {
  tenantDb: TenantDb;
  deal: typeof deals.$inferSelect;
  officeId: string | null;
  eventId: string;
  /**
   * Actor that opened this RFP cycle. Passing it explicitly keeps the payload correct even when the caller
   * enqueues before its `rfp_approval_requested_by` update has been persisted/read back.
   */
  requestedByUserId?: string | null;
}

type ResolvedUserIdentity = { name: string | null; email: string | null };

async function resolveUserIdentity(
  tenantDb: TenantDb,
  userId: string | null | undefined
): Promise<ResolvedUserIdentity | null> {
  if (!userId) return null;
  const [user] = await tenantDb
    .select({
      email: users.email,
      displayName: users.displayName,
      firstName: users.firstName,
      lastName: users.lastName,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return null;
  return {
    name:
      user.displayName?.trim() ||
      [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
      null,
    email: user.email?.trim() || null,
  };
}

/**
 * Resolves the deal's owner independently from the person who requested the RFP.
 * Priority: assigned rep (deal owner) → synced HubSpot owner email → deal creator.
 * Returns null fields when nothing resolves (SyncHub then renders "—").
 *
 * Takes ONLY the three owner columns (not a full deal) so the caller decides where they come from.
 * loadRfpPayloadDeal passes the authoritative values from its own DB fetch, never a sparse projected row.
 */
export async function resolveDealOwner(
  tenantDb: TenantDb,
  deal: Pick<typeof deals.$inferSelect, "assignedRepId" | "hubspotOwnerEmail" | "createdByUserId">
): Promise<{ ownerName: string | null; ownerEmail: string | null }> {
  // 1) Assigned rep — the canonical deal owner.
  const rep = await resolveUserIdentity(tenantDb, deal.assignedRepId);
  if (rep?.email) return { ownerName: rep.name, ownerEmail: rep.email };

  // 2) Fallback: the synced HubSpot owner email (display name unknown).
  const hubspotOwnerEmail = deal.hubspotOwnerEmail?.trim();
  if (hubspotOwnerEmail) return { ownerName: rep?.name ?? null, ownerEmail: hubspotOwnerEmail };

  // 3) Fallback: whoever created the deal.
  const creator = await resolveUserIdentity(tenantDb, deal.createdByUserId);
  if (creator?.email) return { ownerName: creator.name, ownerEmail: creator.email };

  return { ownerName: rep?.name ?? null, ownerEmail: null };
}

/** Resolves the actual user who opened the RFP cycle, not the assigned deal owner. */
export async function resolveRfpRequester(
  tenantDb: TenantDb,
  requestedByUserId: string | null | undefined
): Promise<{ requestedByName: string | null; requestedByEmail: string | null }> {
  const requester = await resolveUserIdentity(tenantDb, requestedByUserId);
  return {
    requestedByName: requester?.name ?? null,
    requestedByEmail: requester?.email ?? null,
  };
}

/**
 * Builds the SyncHub RFP payload deal AUTHORITATIVELY from the database, keyed by deal id. Every field the
 * payload/identity needs is read from this function's own `SELECT d.*` (+ company/contact/lead JOINs + fresh
 * owner/requester resolution) — NEVER from the caller's object — so callers may pass just `{ id }`. This makes the enqueue
 * robust against sparse projected rows (e.g. the override-approve path's narrow `.returning({...})`): a full deal
 * and a bare `{ id }` produce an identical payload. (Previously the deal's own columns — projectType, amounts,
 * address, description, estimator, … — were taken from the passed object, so a sparse row yielded an empty payload.)
 */
async function loadRfpPayloadDeal(
  tenantDb: TenantDb,
  deal: { id: string },
  options: { requestedByUserId?: string | null } = {}
) {
  const result = await tenantDb.execute(sql`
    SELECT d.*,
           c.name AS "companyName",
           concat_ws(' ', pc.first_name, pc.last_name) AS "contactName",
           pc.email AS "clientEmail",
           pc.phone AS "clientPhone",
           l.bid_due_date AS "sourceLeadBidDueDate"
      FROM deals d
      LEFT JOIN companies c ON c.id = d.company_id
      LEFT JOIN contacts pc ON pc.id = d.primary_contact_id
      LEFT JOIN leads l ON l.id = d.source_lead_id
     WHERE d.id = ${deal.id}
     LIMIT 1
  `);
  const rows = Array.isArray(result) ? result : result.rows ?? [];
  const row = rows[0] as Record<string, any> | undefined;
  if (!row) {
    // The deal vanished between the caller's write and this read (should not happen inside a tenant txn). Return a
    // well-formed shell so the builder still produces a valid (if empty) payload rather than throwing.
    return {
      id: deal.id,
      name: "",
      dealNumber: "",
      rfpApprovalRequestEventId: null,
      ownerName: null,
      ownerEmail: null,
      requestedByName: null,
      requestedByEmail: null,
    };
  }

  // Owner resolved from the DB row's authoritative owner columns (never a caller-passed object, which may be a
  // sparse projection). Priority: assigned rep → HubSpot owner email → deal creator (see resolveDealOwner).
  const owner = await resolveDealOwner(tenantDb, {
    assignedRepId: (row.assigned_rep_id as string | null) ?? null,
    hubspotOwnerEmail: (row.hubspot_owner_email as string | null) ?? null,
    createdByUserId: (row.created_by_user_id as string | null) ?? null,
  });
  // Most callers read the requester from the durable deal row. The initial delivery enqueue also supplies the
  // actor explicitly so a pre-persist enqueue cannot accidentally inherit a prior/null database value.
  const requestedByUserId =
    options.requestedByUserId !== undefined
      ? options.requestedByUserId
      : ((row.rfp_approval_requested_by as string | null) ?? null);
  const requester = await resolveRfpRequester(tenantDb, requestedByUserId);

  return {
    id: row.id as string,
    name: (row.name as string | null) ?? "",
    dealNumber: (row.deal_number as string | null) ?? "",
    projectNumber: (row.project_number as string | null) ?? null,
    projectType: (row.project_type as string | null) ?? null,
    workflowRoute: (row.workflow_route as "normal" | "service" | null) ?? null,
    awardedAmount: row.awarded_amount ?? null,
    bidEstimate: row.bid_estimate ?? null,
    ddEstimate: row.dd_estimate ?? null,
    forecastRevenue: row.forecast_revenue ?? null,
    estimator: (row.estimator as string | null) ?? null,
    bidBoardEstimator: (row.bid_board_estimator as string | null) ?? null,
    propertyAddress: (row.property_address as string | null) ?? null,
    propertyCity: (row.property_city as string | null) ?? null,
    propertyState: (row.property_state as string | null) ?? null,
    propertyZip: (row.property_zip as string | null) ?? null,
    propertyCountry: (row.property_country as string | null) ?? null,
    description: (row.description as string | null) ?? null,
    // The deal's own bid_due_date wins; else fall back to the source lead's bid_due_date.
    bidDueDate: row.bid_due_date ?? row.sourceLeadBidDueDate ?? null,
    bidBoardDueDate: row.bid_board_due_date ?? null,
    createdAt: row.created_at ?? null,
    // Round-precise event id for enqueueRfpBidBoardCreate's sourceEventId (authoritative, from the DB row).
    rfpApprovalRequestEventId: (row.rfp_approval_request_event_id as string | null) ?? null,
    companyName: (row.companyName as string | null) ?? null,
    contactName: (row.contactName as string | null) ?? null,
    clientEmail: (row.clientEmail as string | null) ?? null,
    clientPhone: (row.clientPhone as string | null) ?? null,
    ownerName: owner.ownerName,
    ownerEmail: owner.ownerEmail,
    requestedByName: requester.requestedByName,
    requestedByEmail: requester.requestedByEmail,
  };
}

/**
 * Loads the deal's visible files and maps them to RFP attachments. Uses the
 * canonical deal-file scope (files/service): includes the source lead's
 * retained files (buildDealFileScopeCondition) and excludes superseded parent
 * versions (activeLatestFileConditions), so the RFP attachments match the files
 * a reviewer sees on the deal.
 */
export async function loadRfpAttachmentsForDeal(tenantDb: TenantDb, dealId: string) {
  const scopeCondition = await buildDealFileScopeCondition(tenantDb, dealId);
  const rows = await tenantDb
    .select({
      displayName: files.displayName,
      fileExtension: files.fileExtension,
      mimeType: files.mimeType,
      r2Key: files.r2Key,
    })
    .from(files)
    .where(and(scopeCondition, ...activeLatestFileConditions()));

  return buildRfpAttachmentsFromFiles(rows, async ({ r2Key, filename }) =>
    isR2Configured()
      ? await generateDownloadUrl(r2Key, RFP_ATTACHMENT_URL_TTL_SECONDS, filename)
      : generateMockDownloadUrl(r2Key)
  );
}

export async function insertOpportunityRfpRequestJob(
  input: InsertOpportunityRfpJobInput
): Promise<{ jobId: number }> {
  const rfpPayloadDeal = await loadRfpPayloadDeal(input.tenantDb, input.deal, {
    requestedByUserId: input.requestedByUserId,
  });
  const attachments = await loadRfpAttachmentsForDeal(input.tenantDb, input.deal.id);
  const jobRows = await input.tenantDb
    .insert(jobQueue)
    .values({
      jobType: "rfp_request_delivery",
      payload: buildRfpRequestDeliveryPayload({
        deal: rfpPayloadDeal,
        sourceEventId: `crm:deal-stage:opportunity:${input.eventId}`,
        syncHubUrl: resolveSyncHubRfpRequestUrl(),
        attachments,
      }),
      officeId: input.officeId,
      status: "pending",
      runAfter: new Date(),
      // max_attempts=8 gives roughly 2.7 hours of retries with the existing 3^n backoff.
      maxAttempts: 8,
    })
    .returning({ id: jobQueue.id });

  return { jobId: Number(jobRows[0]?.id) };
}

/**
 * Idempotent: returns enqueued=false with reason='already_requested' if
 * rfpApprovalRequestedAt is already set on the deal. This is safe to call from
 * the manual Trigger RFP endpoint after Opportunity scope readiness is satisfied.
 */
export async function enqueueOpportunityRfpIfNeeded(
  input: EnqueueOpportunityRfpInput
): Promise<EnqueueOpportunityRfpResult> {
  if (!isOpportunityRfpEventEnabled()) {
    return { enqueued: false, reason: "feature_disabled" };
  }

  if (input.deal.rfpApprovalRequestedAt != null) {
    return { enqueued: false, reason: "already_requested" };
  }

  const eventId = randomUUID();
  const dealUpdates: Partial<typeof deals.$inferSelect> = {
    rfpApprovalRequestedAt: input.enteredAt,
    rfpApprovalRequestEventId: eventId,
    rfpApprovalRequestedBy: input.userId,
    rfpApprovalStatus: "pending_outbox",
  };
  const { jobId } = await insertOpportunityRfpRequestJob({
    tenantDb: input.tenantDb,
    deal: {
      ...input.deal,
      ...dealUpdates,
    },
    officeId: input.officeId,
    eventId,
    requestedByUserId: input.userId,
  });

  return {
    enqueued: true,
    eventId,
    jobId,
    dealUpdates,
  };
}

/**
 * Enqueue the three-voter invitation email job for an opened vote round. Mirrors insertOpportunityRfpRequestJob's
 * Drizzle insert; the WORKER handler (worker/src/jobs/rfp-vote-invitation.ts) sends the emails. Server-side so the
 * server package (which never imports worker/src at runtime) owns the enqueue.
 */
export async function enqueueRfpVoteInvitation(input: {
  tenantDb: TenantDb;
  // Only the display + round fields are read into the payload; a narrow shape lets both openRfpVoteRound (full
  // row) and the /rfp-retry re-invite path (a getDealById result) call it without a cast.
  deal: { id: string; dealNumber?: string | null; name?: string | null; rfpApprovalRequestEventId?: string | null };
  officeId: string | null;
  // finding: an explicit invited set to snapshot. openRfpVoteRound omits it (resolves the exact trio from env,
  // already gated by hasSufficientRfpVoters). The /rfp-retry re-invite MUST pass the ORIGINAL round's set here so a
  // since-drifted RFP_VOTER_EMAILS can't turn the round into 2-of-4 or strand it — the invitation snapshot is the
  // authoritative voter set the cast route (BC2) checks, so the retry must not re-derive it from a mutable env.
  recipients?: string[];
}): Promise<{ jobId: number }> {
  const recipients =
    input.recipients && input.recipients.length > 0 ? input.recipients : resolveRfpVoterEmails(process.env);

  // Best-effort SyncHub-style project context for the invitation email (reuses the tested payload builder so the
  // number/type/amount/owner/company/location match the create payload). A failure here must NEVER block opening
  // the round — the email degrades to the minimal deal-name + project-number layout.
  let dealSummary: RfpVoteInvitationDealSummary | null = null;
  try {
    // SAVEPOINT so a failed SELECT (e.g. tenant column drift) rolls back to a clean point instead of leaving the
    // tenant transaction in an aborted state — otherwise the job_queue insert below would ALSO fail (Postgres:
    // "current transaction is aborted"), blocking the round from opening. This keeps the "never block the round"
    // promise true.
    await input.tenantDb.execute(sql`SAVEPOINT rfp_vote_summary`);
    const rfpPayloadDeal = await loadRfpPayloadDeal(input.tenantDb, { id: input.deal.id });
    const body = buildNormalizedRfpRequestBody({ deal: rfpPayloadDeal, sourceEventId: "" });
    const addr = body.deal.address;
    dealSummary = {
      projectTypeLabel:
        PROJECT_TYPE_OPTIONS.find((o) => o.code === body.deal.projectType)?.label ?? body.deal.projectType ?? null,
      // FORMATTED number (null for the pending case → the email shows "Pending", never a UUID/HS id).
      projectNumber: resolveDealDisplayNumber({
        projectNumber: rfpPayloadDeal.projectNumber,
        dealNumber: rfpPayloadDeal.dealNumber,
      }),
      amount: body.deal.amount,
      companyName: body.deal.companyName,
      location: addr ? [addr.street, addr.city, addr.state, addr.zip].filter(Boolean).join(", ") || null : null,
      estimator: body.deal.estimator,
      ownerName: body.deal.ownerName,
      description: body.deal.description,
      dueDate: body.deal.dueDate,
    };
    await input.tenantDb.execute(sql`RELEASE SAVEPOINT rfp_vote_summary`);
  } catch {
    // Roll back only the summary work; the outer tenant txn stays usable so the invitation still enqueues.
    await input.tenantDb.execute(sql`ROLLBACK TO SAVEPOINT rfp_vote_summary`).catch(() => {});
    dealSummary = null;
  }

  const jobRows = await input.tenantDb
    .insert(jobQueue)
    .values({
      jobType: "rfp_vote_invitation",
      payload: {
        dealId: input.deal.id,
        dealNumber: input.deal.dealNumber ?? null,
        dealName: input.deal.name ?? null,
        officeId: input.officeId,
        roundEventId: input.deal.rfpApprovalRequestEventId ?? null,
        dealSummary,
        // The SERVER-resolved voter set (finding H5). openRfpVoteRound snapshots the exact trio from env (already
        // gated by hasSufficientRfpVoters) so the worker emails EXACTLY those voters even if its own env is
        // stale/incomplete; the /rfp-retry re-invite passes the ORIGINAL round's set (finding) so the round's
        // authoritative voter set never drifts on retry.
        recipients,
      },
      officeId: input.officeId,
      status: "pending",
      runAfter: new Date(),
      maxAttempts: 5,
    })
    .returning({ id: jobQueue.id });
  return { jobId: Number(jobRows[0]?.id) };
}

/**
 * Enqueue the GO outbound job (2/3-approve OR override-approve): the WORKER HMAC-POSTs the normalized deal body
 * (+ decision:'approved') to SyncHub's /api/bid-board/create-from-rfp. Mirrors insertOpportunityRfpRequestJob but
 * targets the create-from-rfp URL and carries a decision flag so SyncHub creates immediately (no email).
 */
export async function enqueueRfpBidBoardCreate(input: {
  tenantDb: TenantDb;
  // Only the id is required — loadRfpPayloadDeal re-fetches every payload field (incl. the round event id) from
  // the DB, so a sparse projected row (the override-approve path) and a full deal produce an identical job body.
  deal: { id: string };
  officeId: string | null;
}): Promise<{ jobId: number }> {
  const rfpPayloadDeal = await loadRfpPayloadDeal(input.tenantDb, input.deal);
  const attachments = await loadRfpAttachmentsForDeal(input.tenantDb, input.deal.id);
  const body = buildNormalizedRfpRequestBody({
    deal: rfpPayloadDeal,
    sourceEventId: `crm:rfp-vote:approved:${rfpPayloadDeal.rfpApprovalRequestEventId ?? input.deal.id}`,
    attachments,
  });
  const jobRows = await input.tenantDb
    .insert(jobQueue)
    .values({
      jobType: "rfp_bidboard_create",
      payload: {
        dealId: input.deal.id,
        syncHubUrl: resolveSyncHubCreateFromRfpUrl(),
        body: { ...body, decision: "approved" },
      },
      officeId: input.officeId,
      status: "pending",
      runAfter: new Date(),
      maxAttempts: 8,
    })
    .returning({ id: jobQueue.id });
  return { jobId: Number(jobRows[0]?.id) };
}

/**
 * Enqueue the vote-outcome notification job (fires on a DECIDED round). approve -> rep GO email; reject -> rep +
 * Takashi/Adam escalation (the /rfp-review link) — the app-driven no-go escalation, since migration 0148's trigger
 * stays inert for a null-request-id voting decline. Mirrors enqueueRfpVoteInvitation. tenantSchema is resolved by
 * the caller (castRfpVote already resolves it for the decline path) so the worker handler can look up the office.
 */
export async function enqueueRfpVoteOutcome(input: {
  tenantDb: TenantDb;
  officeId: string | null;
  tenantSchema: string;
  deal: typeof deals.$inferSelect;
  outcome: "approved" | "rejected";
  approvals: number;
  rejections: number;
}): Promise<{ jobId: number }> {
  const jobRows = await input.tenantDb
    .insert(jobQueue)
    .values({
      jobType: "rfp_vote_outcome",
      payload: {
        tenantSchema: input.tenantSchema,
        dealId: input.deal.id,
        dealName: input.deal.name ?? null,
        dealNumber: input.deal.dealNumber ?? null,
        requestedByUserId: input.deal.rfpApprovalRequestedBy ?? null,
        rfpVoteRoundId: input.deal.rfpApprovalRequestEventId ?? null,
        outcome: input.outcome,
        approvals: input.approvals,
        rejections: input.rejections,
      },
      officeId: input.officeId,
      status: "pending",
      runAfter: new Date(),
      maxAttempts: 5,
    })
    .returning({ id: jobQueue.id });
  return { jobId: Number(jobRows[0]?.id) };
}
