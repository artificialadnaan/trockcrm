import type { PoolClient } from "pg";
import { buildAuditActorFromSystem } from "../audit/audit-logger.js";
import { logActivityWithPgClient } from "../audit/pg-activity-logger.js";
import { INTERNAL_RFP_RECEIVER } from "../audit/system-processes.js";

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export interface RfpDeclineDealSnapshot {
  id: string;
  name?: string | null;
  deal_number?: string | null;
  project_number?: string | null;
  rfp_approval_status?: string | null;
  rfp_declined_reason?: string | null;
  rfp_declined_at?: string | Date | null;
}

export async function applyRfpDeclineToDeal(input: {
  client: PoolClient;
  schemaName: string;
  deal: RfpDeclineDealSnapshot;
  sourceDealId: string;
  rfpApprovalRequestId: number | null;
  denialReason: string | null;
  declinedAt: string;
  changedByUserId: string;
}): Promise<{ applied: boolean; declinedDeal: RfpDeclineDealSnapshot | null }> {
  const declineUpdate = await input.client.query(
    `UPDATE ${quoteIdent(input.schemaName)}.deals
        SET rfp_approval_status = 'declined',
            rfp_declined_reason = $1,
            rfp_declined_at = $2::timestamptz,
            updated_at = NOW()
      WHERE id = $3
        AND rfp_approval_request_id IS NOT DISTINCT FROM $4
        AND rfp_approval_status IN ('pending_outbox', 'pending')
      RETURNING id, name, deal_number, project_number,
                rfp_approval_status, rfp_declined_reason, rfp_declined_at`,
    [input.denialReason, input.declinedAt, input.sourceDealId, input.rfpApprovalRequestId]
  );

  if ((declineUpdate.rowCount ?? 0) === 0) {
    return { applied: false, declinedDeal: null };
  }

  const declinedDeal = declineUpdate.rows[0] ?? input.deal;
  await input.client.query(
    `INSERT INTO ${quoteIdent(input.schemaName)}.deal_history
       (deal_id, field_name, old_value, new_value, changed_by, source, reason, changed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)`,
    [
      input.sourceDealId,
      "rfp_approval_status",
      input.deal.rfp_approval_status ?? null,
      "declined",
      input.changedByUserId,
      "internal_rfp_decline_callback",
      input.denialReason,
      input.declinedAt,
    ]
  );

  await logActivityWithPgClient({
    client: input.client,
    schemaName: input.schemaName,
    actor: buildAuditActorFromSystem({ systemProcess: INTERNAL_RFP_RECEIVER }),
    action: "update",
    entity: {
      tableName: "deals",
      entityType: "deal",
      recordId: input.sourceDealId,
      nameSnapshot: String(declinedDeal.name ?? input.deal.name ?? "Deal"),
      secondaryIdSnapshot: (declinedDeal.project_number ?? declinedDeal.deal_number ?? input.deal.project_number ?? input.deal.deal_number ?? null) as string | null,
    },
    fieldChanges: {
      rfpApprovalStatus: { from: input.deal.rfp_approval_status ?? null, to: "declined" },
      rfpDeclinedReason: { from: input.deal.rfp_declined_reason ?? null, to: input.denialReason },
      rfpDeclinedAt: { from: input.deal.rfp_declined_at ?? null, to: declinedDeal.rfp_declined_at ?? input.declinedAt },
    },
    metadata: { rfpApprovalRequestId: input.rfpApprovalRequestId },
  });

  return { applied: true, declinedDeal };
}
