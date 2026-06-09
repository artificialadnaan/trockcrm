import { randomUUID } from "node:crypto";
import { and, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { deals, files, jobQueue } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { isOpportunityRfpEventEnabled } from "../../config/feature-flags.js";
import {
  generateDownloadUrl,
  generateMockDownloadUrl,
  isR2Configured,
} from "../../lib/r2-client.js";
import { activeLatestFileConditions, buildDealFileScopeCondition } from "../files/service.js";
import { buildRfpAttachmentsFromFiles, buildRfpRequestDeliveryPayload, resolveSyncHubRfpRequestUrl } from "./rfp-payload.js";

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

async function loadRfpPayloadDeal(tenantDb: TenantDb, fallbackDeal: typeof deals.$inferSelect) {
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
  if (!row) return fallbackDeal;

  return {
    ...fallbackDeal,
    companyName: row.companyName ?? null,
    contactName: row.contactName ?? null,
    clientEmail: row.clientEmail ?? null,
    clientPhone: row.clientPhone ?? null,
    bidDueDate: fallbackDeal.bidDueDate ?? row.sourceLeadBidDueDate ?? null,
  };
}

/**
 * Loads the deal's visible files and maps them to RFP attachments. Uses the
 * canonical deal-file scope (files/service): includes the source lead's
 * retained files (buildDealFileScopeCondition) and excludes superseded parent
 * versions (activeLatestFileConditions), so the RFP attachments match the files
 * a reviewer sees on the deal.
 */
async function loadRfpAttachmentsForDeal(tenantDb: TenantDb, dealId: string) {
  const rows = await tenantDb
    .select({
      displayName: files.displayName,
      fileExtension: files.fileExtension,
      mimeType: files.mimeType,
      r2Key: files.r2Key,
    })
    .from(files)
    .where(
      and(
        await buildDealFileScopeCondition(tenantDb, dealId),
        ...activeLatestFileConditions()
      )
    );

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
