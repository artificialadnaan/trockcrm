import { alias } from "drizzle-orm/pg-core";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { deals, users, pipelineStageConfig } from "@trock-crm/shared/schema";
import { buildEstimatorCondition } from "./deal-filter-predicates.js";
import { buildDealSearchCondition } from "../search/unified-search.js";
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
  /** Status-specific attention reason: decline note / conflict reason / send-failure error (null while awaiting). */
  reason: string | null;
}

// A re-confirmed denial (the override flow's upheld no-go) is a resolved terminal state, not a
// pending RFP — it must not appear in the queue nor be cancellable.
const NOT_RECONFIRMED_DENIAL = sql`coalesce(${deals.rfpOverrideDecision}, '') <> 'denial_reconfirmed'`;
// A declined RFP whose override-approval is in flight (rfp_override_state='approving') is being turned
// into a Bid Board project right now — it must not be cancelled (would orphan the external creation).
const NOT_OVERRIDE_APPROVING = sql`coalesce(${deals.rfpOverrideState}, '') <> 'approving'`;

/**
 * The Pending RFP bucket, as a predicate against an ALIASED `deals` relation — the SQL twin of the
 * shared `isPendingRfpBoardCard`, and the ONE definition of "is this deal in the Pending RFP bucket".
 *
 * Exported because the deals BOARD needs the same membership: its synthetic Pending RFP column can no
 * longer be carved out of the Opportunity column's card slice (that slice is capped, so any pending deal
 * ranked below the cap silently vanished from a column whose header count said it was there). The board
 * fetches its own preview with this predicate instead.
 *
 * Deliberately does NOT include the Opportunity stage bound — callers supply that, because they scope it
 * differently: the cross-rep queue resolves every opportunity-canonical stage id, while the board bounds
 * to the opportunity-family columns it is actually rendering.
 */
/**
 * The COMPLEMENT of the bucket, NULL-safely.
 *
 * The ordinary Opportunity board column has to exclude these rows BEFORE its 50-row cap, not after: the
 * client moves them into the synthetic column, so fetching them into Opportunity's slice and discarding
 * them there meant 50 high-ranked pending deals could leave the ordinary column rendering EMPTY under a
 * correct header count.
 *
 * A bare `NOT (<bucket>)` would be WRONG, and silently so. `rfp_approval_status` is NULL on almost every
 * deal, `NULL IN (...)` is NULL, and `NOT NULL` is NULL — which a WHERE treats as false. That negation
 * would therefore drop every ordinary Opportunity deal and keep only... nothing. Hence the COALESCE.
 */
export function aliasedNotPendingRfpBucketCondition(alias: string) {
  return sql`coalesce(${aliasedPendingRfpBucketCondition(alias)}, false) = false`;
}

export function aliasedPendingRfpBucketCondition(alias: string) {
  const relation = sql.raw(`"${alias.replace(/"/g, '""')}"`);
  return sql`(
    ${relation}.is_bid_board_owned = false
    and coalesce(${relation}.rfp_override_decision, '') <> 'denial_reconfirmed'
    and coalesce(${relation}.rfp_override_state, '') <> 'approving'
    and ${relation}.rfp_approval_status in (${sql.join(
      PENDING_RFP_STATUSES.map((status) => sql`${status}`),
      sql`, `
    )})
  )`;
}

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
export async function getPendingRfpDeals(
  tenantDb: any,
  filters: { estimatorId?: string; search?: string } = {},
): Promise<PendingRfpDeal[]> {
  const oppStageIds = await opportunityStageIds(tenantDb);
  if (oppStageIds.length === 0) return [];

  const triggeredBy = alias(users, "triggered_by");
  const rows = await tenantDb
    .select({
      id: deals.id,
      name: deals.name,
      // `deals.is_change_order` — the AUTHORITY for the change-order display relabel on the client.
      isChangeOrder: deals.isChangeOrder,
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
      rfpConflictReason: deals.rfpConflictReason,
      rfpLastAttemptError: deals.rfpLastAttemptError,
      assignedRepName: users.displayName,
      triggeredByName: triggeredBy.displayName,
    })
    .from(deals)
    .leftJoin(users, eq(users.id, deals.assignedRepId))
    .leftJoin(triggeredBy, eq(triggeredBy.id, deals.rfpApprovalRequestedBy))
    .where(
      and(
        inArray(deals.stageId, oppStageIds),
        // The ONE bucket definition, shared with the board's Pending RFP column preview.
        aliasedPendingRfpBucketCondition("deals"),
        eq(deals.isActive, true),
        sql`coalesce(${deals.isTestData}, false) = false`,
        // The board's Pending RFP column is narrowed by the estimator filter, and clicking it lands here.
        // Without this the destination lists every pending RFP under a count scoped to one person.
        // buildEstimatorCondition (not a bare eq) so a malformed id is a no-match rather than a 22P02.
        //
        // NOTE the asymmetry: assignedRepId is NOT applied here, and that gap PRE-DATES this change — the
        // rep-filtered column has always opened an unfiltered queue. Left alone deliberately rather than
        // silently altering behaviour outside this PR's scope; worth fixing separately.
        ...(filters.estimatorId ? [buildEstimatorCondition(filters.estimatorId)] : []),
        // Same reasoning as the estimator filter directly above, for the board's TEXT search. The Pending
        // RFP column's count and preview are narrowed by it (getDealsForPipeline puts the predicate on
        // commonConditions, which this column's own query shares), so a search-narrowed count that opened
        // the complete queue would repeat the exact divergence that filter exists to close.
        //
        // buildDealSearchCondition is the shared predicate the board, the deals list and the stage
        // drill-down all use, so this queue resolves the same set they do. >= 2 characters, matching
        // getDealsForPipeline's own guard — a shorter term narrows neither, so neither may narrow here.
        ...(filters.search && filters.search.trim().length >= 2
          ? [buildDealSearchCondition(filters.search)]
          : []),
      ),
    )
    .orderBy(asc(deals.rfpApprovalRequestedAt));

  return rows.map((r: any) => ({
    id: r.id,
    name: r.name,
    // Selected above and previously dropped right here — the classic "query has it, mapper loses it".
    isChangeOrder: r.isChangeOrder === true,
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
    // Status-specific "why this needs attention" reason, matching what the deal detail page shows:
    // declined → decline note, conflict → conflict reason, send_failed → last attempt error. Awaiting
    // states (pending_outbox/pending) have no reason yet.
    reason: reasonForPendingRfpRow(r),
  }));
}

function reasonForPendingRfpRow(r: {
  rfpApprovalStatus: string;
  rfpDeclinedReason?: string | null;
  rfpConflictReason?: string | null;
  rfpLastAttemptError?: string | null;
}): string | null {
  switch (r.rfpApprovalStatus) {
    case "declined":
      return r.rfpDeclinedReason ?? null;
    case "conflict":
      return r.rfpConflictReason ?? null;
    case "send_failed":
      return r.rfpLastAttemptError ?? null;
    default:
      return null;
  }
}

// Return a deal to plain Opportunity. Only the "needs attention" states (declined/conflict/send_failed)
// are cancellable — never an in-flight pending_outbox/pending request (which would race the delivery
// worker / approval callbacks). Clears the WHOLE RFP cycle (incl. request id + token + override
// fields) so a late callback or queued job can't resurrect/approve a cancelled deal. The status, stage,
// and override guards are ALL in the WHERE for atomicity: if the row advanced out of Opportunity or
// changed state between the route's read and this update, nothing matches and it returns null (the
// route then 409s) rather than clearing the RFP cycle on a deal that is no longer a pending-RFP row.
export async function cancelPendingRfp(
  tenantDb: any,
  dealId: string,
  // When set (the actor is a rep), the atomic update also requires the deal to STILL be assigned to them,
  // so a reassignment landing between the route's ownership check and this update races to null (409)
  // rather than letting a former owner clear the RFP. Admins/directors pass undefined (cancel any owner).
  requireOwnerId?: string,
): Promise<{ id: string } | null> {
  const oppStageIds = await opportunityStageIds(tenantDb);
  if (oppStageIds.length === 0) return null;
  const ownerGuard = requireOwnerId ? [eq(deals.assignedRepId, requireOwnerId)] : [];
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
      // Clear the per-attempt marker (finding F4/F5) with the rest of the RFP fields so a fresh re-trigger
      // starts with no stale attempt timestamp.
      rfpBidboardAttemptAt: null,
      // Bump updated_at like the other RFP state transitions (rfp-override-service) — deals.updated_at
      // has no $onUpdate, so without this the cancelled deal looks stale in updated_at-ordered lists.
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(deals.id, dealId),
        eq(deals.isActive, true),
        eq(deals.isBidBoardOwned, false),
        inArray(deals.stageId, oppStageIds),
        inArray(deals.rfpApprovalStatus, [...PENDING_RFP_ATTENTION_STATUSES]),
        NOT_RECONFIRMED_DENIAL,
        NOT_OVERRIDE_APPROVING,
        ...ownerGuard,
      ),
    )
    .returning({ id: deals.id });
  return updated ?? null;
}
