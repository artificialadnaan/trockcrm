import { alias } from "drizzle-orm/pg-core";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { deals, users, pipelineStageConfig } from "@trock-crm/shared/schema";
import {
  PENDING_RFP_STATUSES,
  PENDING_RFP_ATTENTION_STATUSES,
  pendingRfpSubStateForStatus,
  toCanonicalDealStageSlug,
  type PendingRfpSubState,
} from "@trock-crm/shared/types";

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

// A re-confirmed denial (the override flow's upheld no-go) is a resolved terminal state, not a
// pending RFP — it must not appear in the queue nor be cancellable.
const NOT_RECONFIRMED_DENIAL = sql`coalesce(${deals.rfpOverrideDecision}, '') <> 'denial_reconfirmed'`;

// All stage ids that canonicalize to Opportunity (incl. legacy aliases like `dd`), matching what the
// trigger route accepts and how the board buckets cards.
async function opportunityStageIds(tenantDb: any): Promise<string[]> {
  const stages = await tenantDb
    .select({ id: pipelineStageConfig.id, slug: pipelineStageConfig.slug })
    .from(pipelineStageConfig);
  return stages
    .filter(
      (s: { slug: string | null }) =>
        s.slug != null &&
        (toCanonicalDealStageSlug(s.slug, "normal") === "opportunity" ||
          toCanonicalDealStageSlug(s.slug, "service") === "opportunity"),
    )
    .map((s: { id: string }) => s.id);
}

// Cross-rep, office-scoped (office isolation is enforced by the tenant schema → NO owner filter,
// NO office WHERE). Returns the Pending-RFP bucket oldest-first.
export async function getPendingRfpDeals(tenantDb: any): Promise<PendingRfpDeal[]> {
  const oppStageIds = await opportunityStageIds(tenantDb);
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
        NOT_RECONFIRMED_DENIAL,
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

// Return a deal to plain Opportunity. Only the "needs attention" states (declined/conflict/send_failed)
// are cancellable — never an in-flight pending_outbox/pending request (which would race the delivery
// worker / approval callbacks). Clears the WHOLE RFP cycle (incl. request id + token + override
// fields) so a late callback or queued job can't resurrect/approve a cancelled deal. The status guard
// is in the WHERE for atomicity: returns null if the row changed concurrently.
export async function cancelPendingRfp(tenantDb: any, dealId: string): Promise<{ id: string } | null> {
  const [updated] = await tenantDb
    .update(deals)
    .set({
      rfpApprovalStatus: null,
      rfpApprovalRequestedAt: null,
      rfpApprovalRequestedBy: null,
      rfpApprovalRequestEventId: null,
      rfpApprovalRequestId: null,
      rfpApprovalToken: null,
      rfpDeclinedReason: null,
      rfpDeclinedAt: null,
      rfpConflictReason: null,
      rfpConflictWith: null,
      rfpLastAttemptError: null,
      rfpOverrideState: null,
      rfpOverrideDecision: null,
      rfpOverrideError: null,
      rfpOverrideNote: null,
      rfpOverrideReviewedAt: null,
      rfpOverrideReviewedBy: null,
    })
    .where(
      and(
        eq(deals.id, dealId),
        eq(deals.isBidBoardOwned, false),
        inArray(deals.rfpApprovalStatus, [...PENDING_RFP_ATTENTION_STATUSES]),
        NOT_RECONFIRMED_DENIAL,
      ),
    )
    .returning({ id: deals.id });
  return updated ?? null;
}
