import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { deals, jobQueue } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { isOpportunityRfpEventEnabled } from "../../config/feature-flags.js";
import { buildRfpRequestDeliveryPayload, resolveSyncHubRfpRequestUrl } from "./rfp-payload.js";

type TenantDb = NodePgDatabase<typeof schema>;

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
 * Idempotent: returns enqueued=false with reason='already_requested' if
 * rfpApprovalRequestedAt is already set on the deal. This is safe to call from
 * any code path that puts a deal into Opportunity, including stage changes,
 * lead conversion, and future creation paths.
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
  const rfpPayloadDeal = await loadRfpPayloadDeal(input.tenantDb, {
    ...input.deal,
    ...dealUpdates,
  });
  const jobRows = await input.tenantDb
    .insert(jobQueue)
    .values({
      jobType: "rfp_request_delivery",
      payload: buildRfpRequestDeliveryPayload({
        deal: rfpPayloadDeal,
        sourceEventId: `crm:deal-stage:opportunity:${eventId}`,
        syncHubUrl: resolveSyncHubRfpRequestUrl(),
      }),
      officeId: input.officeId,
      status: "pending",
      runAfter: new Date(),
      // max_attempts=8 gives roughly 2.7 hours of retries with the existing 3^n backoff.
      maxAttempts: 8,
    })
    .returning({ id: jobQueue.id });

  return {
    enqueued: true,
    eventId,
    jobId: Number(jobRows[0]?.id),
    dealUpdates,
  };
}
