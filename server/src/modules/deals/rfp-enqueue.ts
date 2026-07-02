import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { deals, files, jobQueue, users } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
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
}

/**
 * Resolves the deal's owner — the "Requested by" person shown on the SyncHub RFP email.
 * Priority: assigned rep (deal owner) → synced HubSpot owner email → deal creator.
 * Returns null fields when nothing resolves (SyncHub then renders "—").
 */
export async function resolveDealOwner(
  tenantDb: TenantDb,
  deal: typeof deals.$inferSelect
): Promise<{ ownerName: string | null; ownerEmail: string | null }> {
  const lookupUser = async (
    userId: string | null | undefined
  ): Promise<{ ownerName: string | null; ownerEmail: string | null } | null> => {
    if (!userId) return null;
    const [u] = await tenantDb
      .select({
        email: users.email,
        displayName: users.displayName,
        firstName: users.firstName,
        lastName: users.lastName,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!u) return null;
    const name =
      u.displayName?.trim() ||
      [u.firstName, u.lastName].filter(Boolean).join(" ").trim() ||
      null;
    return { ownerName: name, ownerEmail: u.email ?? null };
  };

  // 1) Assigned rep — the deal's owner; the canonical requester.
  const rep = await lookupUser(deal.assignedRepId);
  if (rep?.ownerEmail) return rep;

  // 2) Fallback: the synced HubSpot owner email (display name unknown).
  const hubspotOwnerEmail = deal.hubspotOwnerEmail?.trim();
  if (hubspotOwnerEmail) return { ownerName: rep?.ownerName ?? null, ownerEmail: hubspotOwnerEmail };

  // 3) Fallback: whoever created the deal.
  const creator = await lookupUser(deal.createdByUserId);
  if (creator?.ownerEmail) return creator;

  return { ownerName: rep?.ownerName ?? null, ownerEmail: null };
}

async function loadRfpPayloadDeal(tenantDb: TenantDb, fallbackDeal: typeof deals.$inferSelect) {
  const owner = await resolveDealOwner(tenantDb, fallbackDeal);
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
     WHERE d.id = ${fallbackDeal.id}
     LIMIT 1
  `);
  const rows = Array.isArray(result) ? result : result.rows ?? [];
  const row = rows[0] as Record<string, any> | undefined;
  if (!row) return { ...fallbackDeal, ...owner };

  return {
    ...fallbackDeal,
    companyName: row.companyName ?? null,
    contactName: row.contactName ?? null,
    clientEmail: row.clientEmail ?? null,
    clientPhone: row.clientPhone ?? null,
    bidDueDate: fallbackDeal.bidDueDate ?? row.sourceLeadBidDueDate ?? null,
    ownerName: owner.ownerName,
    ownerEmail: owner.ownerEmail,
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
  const rfpPayloadDeal = await loadRfpPayloadDeal(input.tenantDb, input.deal);
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
  deal: typeof deals.$inferSelect;
  officeId: string | null;
}): Promise<{ jobId: number }> {
  const jobRows = await input.tenantDb
    .insert(jobQueue)
    .values({
      jobType: "rfp_vote_invitation",
      payload: {
        dealId: input.deal.id,
        dealNumber: input.deal.dealNumber ?? null,
        dealName: input.deal.name ?? null,
        officeId: input.officeId,
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
  deal: typeof deals.$inferSelect;
  officeId: string | null;
}): Promise<{ jobId: number }> {
  const rfpPayloadDeal = await loadRfpPayloadDeal(input.tenantDb, input.deal);
  const attachments = await loadRfpAttachmentsForDeal(input.tenantDb, input.deal.id);
  const body = buildNormalizedRfpRequestBody({
    deal: rfpPayloadDeal,
    sourceEventId: `crm:rfp-vote:approved:${input.deal.rfpApprovalRequestEventId ?? input.deal.id}`,
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
