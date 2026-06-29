import { alias } from "drizzle-orm/pg-core";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { deals, users, pipelineStageConfig } from "@trock-crm/shared/schema";
import { PENDING_RFP_STATUSES, pendingRfpSubStateForStatus, type PendingRfpSubState } from "@trock-crm/shared/types";

export interface PendingRfpDeal {
  id: string;
  name: string;
  projectNumber: string | null;
  dealNumber: string | null;
  workflowRoute: string;
  assignedRepId: string | null;
  assignedRepName: string | null;
  rfpApprovalStatus: string;
  subState: PendingRfpSubState;
  triggeredById: string | null;
  triggeredByName: string | null;
  triggeredAt: string | null;
  declineReason: string | null;
}

// Cross-rep, office-scoped (office isolation is enforced by the tenant schema → NO owner filter,
// NO office WHERE). Returns the Pending-RFP bucket oldest-first.
export async function getPendingRfpDeals(tenantDb: any): Promise<PendingRfpDeal[]> {
  const oppStages = await tenantDb
    .select({ id: pipelineStageConfig.id })
    .from(pipelineStageConfig)
    .where(eq(pipelineStageConfig.slug, "opportunity"));
  const oppStageIds = oppStages.map((s: { id: string }) => s.id);
  if (oppStageIds.length === 0) return [];

  const triggeredBy = alias(users, "triggered_by");
  const rows = await tenantDb
    .select({
      id: deals.id,
      name: deals.name,
      projectNumber: deals.projectNumber,
      dealNumber: deals.dealNumber,
      workflowRoute: deals.workflowRoute,
      stageId: deals.stageId,
      isBidBoardOwned: deals.isBidBoardOwned,
      assignedRepId: deals.assignedRepId,
      rfpApprovalStatus: deals.rfpApprovalStatus,
      rfpApprovalRequestedAt: deals.rfpApprovalRequestedAt,
      rfpApprovalRequestedBy: deals.rfpApprovalRequestedBy,
      rfpDeclinedReason: deals.rfpDeclinedReason,
      assignedRepName: users.displayName,
      triggeredByName: triggeredBy.displayName,
    })
    .from(deals)
    .leftJoin(users, eq(users.id, deals.assignedRepId))
    .leftJoin(triggeredBy, eq(triggeredBy.id, deals.rfpApprovalRequestedBy))
    .where(
      and(
        inArray(deals.stageId, oppStageIds),
        eq(deals.isBidBoardOwned, false),
        inArray(deals.rfpApprovalStatus, [...PENDING_RFP_STATUSES]),
        eq(deals.isActive, true),
        sql`coalesce(${deals.isTestData}, false) = false`,
      ),
    )
    .orderBy(asc(deals.rfpApprovalRequestedAt));

  return rows.map((r: any) => ({
    id: r.id,
    name: r.name,
    projectNumber: r.projectNumber ?? null,
    dealNumber: r.dealNumber ?? null,
    workflowRoute: r.workflowRoute ?? "normal",
    assignedRepId: r.assignedRepId ?? null,
    assignedRepName: r.assignedRepName ?? null,
    rfpApprovalStatus: r.rfpApprovalStatus,
    subState: pendingRfpSubStateForStatus(r.rfpApprovalStatus)!,
    triggeredById: r.rfpApprovalRequestedBy ?? null,
    triggeredByName: r.triggeredByName ?? null,
    triggeredAt: r.rfpApprovalRequestedAt ? new Date(r.rfpApprovalRequestedAt).toISOString() : null,
    declineReason: r.rfpDeclinedReason ?? null,
  }));
}
