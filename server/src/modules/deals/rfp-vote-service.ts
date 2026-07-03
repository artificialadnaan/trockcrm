import { randomUUID } from "node:crypto";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import { deals, rfpVotes } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import {
  computeRfpVoteState,
  type RfpVoteOutcome,
  type RfpVoteRecord,
} from "@trock-crm/shared/lib/rfpVoteState";
import { resolveRfpVoterEmails } from "@trock-crm/shared/lib/rfpVoterEmails";
import { AppError } from "../../middleware/error-handler.js";
import { resolveProjectTypeCode } from "../../services/projectNumber.js";
import { applyRfpDeclineToDeal } from "./rfp-decline-service.js";
import { enqueueRfpBidBoardCreate, enqueueRfpVoteInvitation, enqueueRfpVoteOutcome } from "./rfp-enqueue.js";

type TenantDb = NodePgDatabase<typeof schema>;
type DealRow = typeof deals.$inferSelect;

// v1 is a fixed global trio (Sidney, Tim, James); the decline summary reads "(N of 3)".
const RFP_VOTER_COUNT = 3;

/**
 * True iff the configured voter allowlist is EXACTLY the fixed RFP_VOTER_COUNT trio. It must be exact, not
 * "at least": requireRfpVoter and the invitation worker both authorize every address resolveRfpVoterEmails
 * returns, so
 *   - FEWER than 3 (a RFP_VOTER_EMAILS typo that drops a comma) can never reach the 2-of-3 tally — the round
 *     sits 'pending' forever, and 'pending' is not a cancellable attention state, so the deal strands; and
 *   - MORE than 3 (an accidental 4th address) makes it a 2-of-4 while the UI + decline summary still say
 *     "(N of 3)" — the extra person can cast a deciding vote (finding G2).
 * Either misconfiguration falls back to the existing SyncHub delivery path instead of opening a mis-sized round.
 */
export function hasSufficientRfpVoters(env: NodeJS.ProcessEnv): boolean {
  return resolveRfpVoterEmails(env).length === RFP_VOTER_COUNT;
}

/**
 * True iff the tenant's rfp_votes table exists (migration 0175 applied for THIS office). The trigger-rfp voting
 * branch probes this so that, if ENABLE_RFP_VOTING is on for an office whose migration hasn't run, it falls back
 * to the SyncHub path instead of opening a round whose first /rfp-vote POST would 500 on `insert(rfpVotes)` and
 * strand the deal 'pending' (uncancellable) — the detail loader tolerates the missing table, so voters would
 * otherwise reach a form that can never record a vote (finding G1). to_regclass returns NULL (no error, no txn
 * abort) for a missing relation, resolved against the tenant search_path.
 */
export async function rfpVotesTableExists(tenantDb: TenantDb): Promise<boolean> {
  const res: any = await tenantDb.execute(sql`SELECT to_regclass('rfp_votes') AS reg`);
  const rows = Array.isArray(res) ? res : res.rows ?? [];
  return rows[0]?.reg != null;
}

export interface CastRfpVoteDeps {
  applyDecline?: typeof applyRfpDeclineToDeal;
  enqueueBidBoardCreate?: typeof enqueueRfpBidBoardCreate;
  enqueueOutcome?: typeof enqueueRfpVoteOutcome;
  now?: () => Date;
}

/** Service / type-4 == project-type code '4'. Voting applies ONLY to non-service deals. */
export function isServiceRfp(deal: { projectType?: string | null; workflowRoute?: "normal" | "service" | null }): boolean {
  return (
    resolveProjectTypeCode({
      projectType: deal.projectType,
      workflowRoute: deal.workflowRoute ?? "normal",
    }) === "4"
  );
}

/**
 * Open a non-service RFP vote round. Guarded conditional UPDATE (same reserve style as trigger-rfp) stamps
 * rfp_approval_requested_at + a fresh rfp_approval_request_event_id (the round key) + requested_by +
 * rfp_approval_status='pending', then enqueues the three-voter invitation email. Does NOT call SyncHub.
 */
export async function openRfpVoteRound(args: {
  tenantDb: TenantDb;
  officeId: string | null;
  deal: DealRow;
  requestedByUserId: string;
  // When set (a rep-triggered request), the atomic reserve re-binds ownership to this rep so a deal reassigned
  // between the route's read and this UPDATE no longer matches — the former owner 409s instead of opening a
  // round for another rep's deal. Directors/admins pass null (reserve regardless of owner). Mirrors the rep
  // guard the SyncHub trigger-rfp reservation adds.
  enforceAssignedRepId?: string | null;
}): Promise<void> {
  const eventId = randomUUID();
  const requestedAt = new Date();
  const reserveStamps = {
    rfpApprovalRequestedAt: requestedAt,
    rfpApprovalRequestEventId: eventId,
    rfpApprovalRequestedBy: args.requestedByUserId,
    rfpApprovalStatus: "pending",
  } as const;
  const reserveConditions = [
    eq(deals.id, args.deal.id),
    eq(deals.stageId, args.deal.stageId),
    isNull(deals.rfpApprovalStatus),
    isNull(deals.rfpApprovalRequestedAt),
    eq(deals.isBidBoardOwned, false),
    or(isNull(deals.bidBoardStageSlug), eq(deals.bidBoardStageSlug, ""))!,
    eq(deals.isReadOnlyMirror, false),
    isNull(deals.readOnlySyncedAt),
    isNull(deals.bidBoardStageEnteredAt),
    isNull(deals.bidBoardMirrorSourceEnteredAt),
  ];
  if (args.enforceAssignedRepId != null) {
    reserveConditions.push(eq(deals.assignedRepId, args.enforceAssignedRepId));
  }
  const [reserved] = await args.tenantDb
    .update(deals)
    .set(reserveStamps)
    .where(and(...reserveConditions))
    .returning({ id: deals.id });

  if (!reserved) {
    throw new AppError(409, "RFP review has already been triggered for this deal.", "RFP_ALREADY_TRIGGERED");
  }

  await enqueueRfpVoteInvitation({
    tenantDb: args.tenantDb,
    deal: { ...args.deal, ...reserveStamps },
    officeId: args.officeId,
  });
}

/** "Rejected by vote (2 of 3). <email>: <reason>; ..." — aggregated from the reject votes. */
export function buildRfpVoteDeclineReason(votes: RfpVoteRecord[]): string {
  const rejects = votes.filter((v) => v.decision === "reject");
  const detail = rejects
    .map((v) => `${v.voterEmail}: ${(v.reason ?? "").trim() || "No reason provided"}`)
    .join("; ");
  return `Rejected by vote (${rejects.length} of ${RFP_VOTER_COUNT}). ${detail}`;
}

/**
 * Cast one vote inside the atomic tally. FOR UPDATE serializes concurrent votes on the deal; the vote is
 * inserted (unique-violation -> 409); the round is recounted before + after; and the outcome fires exactly
 * once — only when THIS vote crossed pending -> decided (approve keeps status 'pending', so the transition,
 * not a status change, is the idempotency signal). approve -> enqueue rfp_bidboard_create; reject ->
 * applyRfpDeclineToDeal with the aggregated reason.
 */
export async function castRfpVote(
  args: {
    tenantDb: TenantDb;
    officeId: string | null;
    deal: DealRow;
    voter: { userId: string; email: string };
    decision: "approve" | "reject";
    reason: string | null;
  },
  deps: CastRfpVoteDeps = {},
): Promise<{ outcome: RfpVoteOutcome; votes: RfpVoteRecord[] }> {
  const applyDecline = deps.applyDecline ?? applyRfpDeclineToDeal;
  const enqueueCreate = deps.enqueueBidBoardCreate ?? enqueueRfpBidBoardCreate;
  const enqueueOutcome = deps.enqueueOutcome ?? enqueueRfpVoteOutcome;
  const now = deps.now ?? (() => new Date());

  const roundEventId = args.deal.rfpApprovalRequestEventId;
  if (!roundEventId) {
    throw new AppError(409, "This deal is not in an open RFP vote round.", "RFP_NO_VOTE_ROUND");
  }

  // Serialize concurrent votes on this deal so the pending->decided transition below is race-free, AND re-read
  // the deal's AUTHORITATIVE state under the lock (finding H3). The route's pre-checks (is_active, open round)
  // can go stale in the gap before this lock — a soft-delete or a Return-to-Opportunity/re-trigger can land
  // between them. Voting on a since-deleted/closed/re-triggered deal would (for an approving vote) enqueue
  // rfp_bidboard_create for a deal the bid-board-created callback can't reconcile (its findDeal filters
  // is_active=true), so validate the locked row before recording the vote. The decided-round case is left to
  // priorState below (so it still returns the specific RFP_ROUND_DECIDED).
  const lockedRes: any = await args.tenantDb.execute(
    sql`SELECT is_active, rfp_approval_request_id, rfp_approval_request_event_id
          FROM deals WHERE id = ${args.deal.id} FOR UPDATE`
  );
  const lockedRows = Array.isArray(lockedRes) ? lockedRes : lockedRes.rows ?? [];
  const locked = lockedRows[0];
  if (!locked || locked.is_active === false) {
    throw new AppError(404, "Deal not found.");
  }
  if (locked.rfp_approval_request_id != null) {
    // a legacy SyncHub-request deal is not decided by vote (mirrors the route's pre-check, re-verified locked)
    throw new AppError(409, "This RFP is not decided by vote.", "RFP_NO_VOTE_ROUND");
  }
  if (locked.rfp_approval_request_event_id !== roundEventId) {
    // the round was cleared (Return to Opportunity → NULL) or re-triggered (new event id) since the route read
    throw new AppError(409, "This deal is not in an open RFP vote round.", "RFP_NO_VOTE_ROUND");
  }

  const priorState = computeRfpVoteState(await loadRoundVotes(args.tenantDb, args.deal.id, roundEventId));

  // Reject late votes once the round is already decided (2-of-3 threshold crossed). Without this a 3rd
  // voter can POST a valid vote row that never triggers an action but silently lands in rfp_votes.
  if (priorState.outcome !== "pending") {
    throw new AppError(409, "This RFP vote round has already been decided.", "RFP_ROUND_DECIDED");
  }

  try {
    await args.tenantDb.insert(rfpVotes).values({
      dealId: args.deal.id,
      roundEventId,
      voterUserId: args.voter.userId,
      voterEmail: args.voter.email,
      decision: args.decision,
      reason: args.decision === "reject" ? args.reason : null,
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError(409, "You have already voted on this RFP.", "RFP_ALREADY_VOTED");
    }
    throw err;
  }

  const votes = await loadRoundVotes(args.tenantDb, args.deal.id, roundEventId);
  const state = computeRfpVoteState(votes);

  if (priorState.outcome === "pending" && state.outcome !== "pending") {
    // Resolve the office schema once — needed for both the decline write and the outcome-email enqueue.
    const schemaName = await resolveOfficeSchemaName(args.tenantDb, args.officeId);
    if (state.outcome === "approved") {
      await enqueueCreate({ tenantDb: args.tenantDb, deal: args.deal, officeId: args.officeId });
    } else {
      const client = (args.tenantDb as unknown as { $client: PoolClient }).$client;
      await applyDecline({
        client,
        schemaName,
        deal: {
          id: args.deal.id,
          name: args.deal.name,
          deal_number: args.deal.dealNumber,
          project_number: args.deal.projectNumber,
          rfp_approval_status: args.deal.rfpApprovalStatus,
        },
        sourceDealId: args.deal.id,
        rfpApprovalRequestId: args.deal.rfpApprovalRequestId ?? null,
        denialReason: buildRfpVoteDeclineReason(votes),
        declinedAt: now().toISOString(),
        changedByUserId: args.voter.userId,
      });
    }
    // App-driven outcome notification (GO: rep; NO-GO: rep + Takashi/Adam via /rfp-review) — Task 19 handler.
    // The 0148 trigger stays inert for null-request-id voting declines, so this is the only escalation path.
    await enqueueOutcome({
      tenantDb: args.tenantDb,
      officeId: args.officeId,
      tenantSchema: schemaName,
      deal: args.deal,
      outcome: state.outcome,
      approvals: state.approvals,
      rejections: state.rejections,
    });
  }

  return { outcome: state.outcome, votes };
}

async function loadRoundVotes(tenantDb: TenantDb, dealId: string, roundEventId: string): Promise<RfpVoteRecord[]> {
  const rows = await tenantDb
    .select({
      voterUserId: rfpVotes.voterUserId,
      voterEmail: rfpVotes.voterEmail,
      decision: rfpVotes.decision,
      reason: rfpVotes.reason,
      createdAt: rfpVotes.createdAt,
    })
    .from(rfpVotes)
    .where(and(eq(rfpVotes.dealId, dealId), eq(rfpVotes.roundEventId, roundEventId)))
    .orderBy(rfpVotes.createdAt);
  return rows.map((r) => ({
    voterUserId: r.voterUserId,
    voterEmail: r.voterEmail,
    decision: r.decision as "approve" | "reject",
    reason: r.reason,
    createdAt: r.createdAt,
  }));
}

async function resolveOfficeSchemaName(tenantDb: TenantDb, officeId: string | null): Promise<string> {
  if (!officeId) {
    throw new AppError(500, "Cannot resolve the office schema for the RFP decline (missing officeId).");
  }
  const res: any = await tenantDb.execute(sql`SELECT slug FROM public.offices WHERE id = ${officeId} LIMIT 1`);
  const rows = Array.isArray(res) ? res : res.rows ?? [];
  const slug = rows[0]?.slug;
  if (typeof slug !== "string" || !/^[a-z][a-z0-9_]*$/.test(slug)) {
    throw new AppError(500, `Unable to resolve office schema for officeId=${officeId}`);
  }
  return `office_${slug}`;
}

function isUniqueViolation(err: unknown): boolean {
  // Drizzle wraps driver errors in a DrizzleQueryError whose `.cause` carries the raw pg error
  // (code 23505). Walk the cause chain so we detect the unique-violation from either level.
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur; depth += 1) {
    if ((cur as { code?: string }).code === "23505") return true;
    const msg = cur instanceof Error ? cur.message : String(cur);
    if (/duplicate key value|unique constraint|rfp_votes_deal_round_voter_uq/i.test(msg)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}
