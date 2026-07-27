import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { dealApprovals } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { writeAuditLog } from "../../lib/audit-log.js";

type TenantDb = NodePgDatabase<typeof schema>;

/**
 * Retire every approval record a deal accumulated on the cycle it is leaving — by DELETING the rows,
 * itemized into audit_log.
 *
 * THE REQUIREMENT this satisfies, stated once so both owners are held to it:
 *
 *   (a) after a retirement, the deal MUST be able to request the same approval again — same
 *       (deal_id, target_stage_id, required_role) — when it re-advances; and
 *   (b) NO record left behind may later become an approval that satisfies validateStageGate for the
 *       cycle that was just retired.
 *
 * Marking rows `rejected` in place — what both call sites used to do — satisfies NEITHER.
 *
 *   (a) fails because `deal_approvals` is UNIQUE on (deal_id, target_stage_id, required_role) with
 *       `status` NOT in the key (shared/src/schema/tenant/deal-approvals.ts), and POST
 *       /api/deals/:id/approvals is a bare INSERT with no onConflict. The retained `rejected` row keeps
 *       occupying the key, so the re-request raises 23505 and the route 500s. A deal moved back and then
 *       progressed again is exactly the case that has to re-request, so the retirement itself was what
 *       made the approval unobtainable.
 *   (b) fails because a row still `pending` is not matched by a status='approved' predicate. It survives
 *       the retirement, the resolution route (PATCH …/approvals/:approvalId) will happily resolve it to
 *       `approved` afterwards, and validateStageGate — which matches on
 *       (deal_id, target_stage_id, status='approved') with no notion of cycle — then accepts it. The
 *       retired cycle's approval is granted after the fact.
 *
 * Deleting satisfies both by construction and needs no cycle discriminator on a shared table: there is
 * nothing left to collide with and nothing left to resolve. The forensic record moves to audit_log, one
 * `delete` row per approval naming the stage, role and status it died in — the same shape
 * removeCommissionForDeal already uses for the money it destroys on this path, so "what was torn down"
 * is answered by one audit_log query either way. Nothing renders the per-deal approval list in the
 * client (only the gate's missing-role checklist), so no surface loses history it was showing.
 *
 * `triggeredByUserId` may be null for a system/cascade actor.
 */
export async function retireDealApprovals(
  tenantDb: TenantDb,
  dealId: string,
  triggeredByUserId: string | null,
  reason: string
): Promise<number> {
  const removed = await tenantDb
    .delete(dealApprovals)
    .where(eq(dealApprovals.dealId, dealId))
    .returning({
      id: dealApprovals.id,
      targetStageId: dealApprovals.targetStageId,
      requiredRole: dealApprovals.requiredRole,
      status: dealApprovals.status,
      approvedBy: dealApprovals.approvedBy,
    });

  for (const row of removed) {
    await writeAuditLog(tenantDb, {
      tableName: "deal_approvals",
      recordId: row.id,
      action: "delete",
      changedBy: triggeredByUserId,
      changes: {
        dealId: { from: dealId, to: null },
        targetStageId: { from: row.targetStageId, to: null },
        requiredRole: { from: row.requiredRole, to: null },
        status: { from: row.status, to: null },
        approvedBy: { from: row.approvedBy, to: null },
        retiredBecause: { from: null, to: reason },
      },
    });
  }

  return removed.length;
}
