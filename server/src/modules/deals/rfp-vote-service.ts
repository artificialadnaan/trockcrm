import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import { deals, jobQueue, leads, rfpVotes, userOfficeAccess, users } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import {
  computeRfpVoteState,
  type RfpVoteOutcome,
  type RfpVoteRecord,
} from "@trock-crm/shared/lib/rfpVoteState";
import { isRfpVoterEmail, resolveRfpVoterEmails } from "@trock-crm/shared/lib/rfpVoterEmails";
import { AppError } from "../../middleware/error-handler.js";
import { logActivity, type AuditContext } from "../audit/audit-logger.js";
import type { RawAuditFieldChange } from "../audit/field-formatters.js";
import { isCrmUserRole } from "../../middleware/field-auth.js";
import { resolveProjectTypeCode } from "../../services/projectNumber.js";
import { applyRfpDeclineToDeal } from "./rfp-decline-service.js";
import { recordDescriptionHistoryChange } from "./deal-description-history.js";
import { buildRfpVoteDealUpdate, writeRfpVoteDealUpdate, type RfpVoteEditableFields } from "./rfp-vote-edits.js";
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
 * True iff the tenant's rfp_votes table exists (migration 0176 applied for THIS office). The trigger-rfp voting
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

/**
 * True iff EVERY configured RFP voter email resolves to an ACTIVE user who can BOTH enter `officeId` AND pass
 * requireCrmUser there. Access mirrors the auth middleware's getOfficeAccess (primary office is `officeId`, OR a
 * user_office_access grant for it); the CRM-role check mirrors authMiddleware's effective-role resolution + the
 * requireCrmUser mount guard (a field_contractor effective role can't load /rfp-vote or the detail ballot). The
 * trigger-rfp guard requires this before opening a request-less round — otherwise the invite link (which carries
 * officeId) is rejected, or the voter reaches a CRM route they can't use, and if fewer than the trio can vote the
 * deal is stranded 'pending' with no cancel path. When it's not satisfied the trigger falls back to the SyncHub
 * delivery path. (Called only after hasSufficientRfpVoters, so the trio is configured.)
 */
export async function allRfpVotersHaveOfficeAccess(
  tenantDb: TenantDb,
  officeId: string | null,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const emails = resolveRfpVoterEmails(env).map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0);
  if (emails.length === 0 || !officeId) return false;
  const rows = await tenantDb
    .select({
      email: users.email,
      baseRole: users.role,
      primaryOfficeId: users.officeId,
      grantOfficeId: userOfficeAccess.officeId,
      grantRoleOverride: userOfficeAccess.roleOverride,
    })
    .from(users)
    .leftJoin(
      userOfficeAccess,
      and(eq(userOfficeAccess.userId, users.id), eq(userOfficeAccess.officeId, officeId)),
    )
    // finding: also require the user to be ACTIVE — authMiddleware rejects a deactivated user before they can load
    // or cast, so a configured-but-deactivated voter must not count toward the trio (else the round can open with
    // fewer than three votable voters and strand).
    .where(and(inArray(sql`lower(${users.email})`, emails), eq(users.isActive, true)));
  const ready = new Set(
    rows
      .filter((r) => {
        const isHomeOffice = r.primaryOfficeId === officeId;
        const hasGrant = r.grantOfficeId != null;
        // Must be able to ENTER this office at all (home office or an explicit grant for it).
        if (!isHomeOffice && !hasGrant) return false;
        // finding: and must pass requireCrmUser THERE. Both /api/deals/:id/detail (load the ballot) and
        // /rfp-vote (cast) are mounted behind requireCrmUser, so a field_contractor EFFECTIVE role can neither
        // load nor vote — counting them would open a round with fewer than three usable voters that can't reach
        // 2-of-3. Mirror authMiddleware's effective-role resolution (middleware/auth.ts): at the voter's HOME
        // office the effective role is users.role; when they reach a NON-home office via a grant it is that
        // grant's role_override (else users.role). isCrmUserRole is the exact predicate requireCrmUser applies.
        const effectiveRole = isHomeOffice ? r.baseRole : (r.grantRoleOverride ?? r.baseRole);
        return isCrmUserRole(effectiveRole);
      })
      .map((r) => (r.email ?? "").trim().toLowerCase()),
  );
  return emails.every((e) => ready.has(e));
}

export interface CastRfpVoteDeps {
  applyDecline?: typeof applyRfpDeclineToDeal;
  enqueueBidBoardCreate?: typeof enqueueRfpBidBoardCreate;
  enqueueOutcome?: typeof enqueueRfpVoteOutcome;
  now?: () => Date;
}

/**
 * The FULL /deals/:id/rfp-vote handler body: request validation, open-round + flag gating, the service-vs-open-round
 * check, invitation-snapshot authorization (env fallback), and the atomic cast. Shared by the Express route AND its
 * runtime test so the two can never drift (the test used to re-implement this inline). Throws AppError; the route
 * translates errors + owns transaction commit. `votingEnabled` is injected so the service needn't import the flag.
 */
export async function authorizeAndCastRfpVote(
  input: {
    tenantDb: TenantDb;
    deal: (DealRow & { isActive?: boolean }) | null | undefined;
    user: { id: string; email: string | null };
    decision: unknown;
    reason: unknown;
    // Optional SyncHub-style edited fields (approve only). On the FIRST approve of a round they are committed to
    // the deal (and the deal locks); on a later vote they are rejected (RFP_VOTE_ALREADY_LOCKED); on a reject they
    // are rejected (RFP_VOTE_EDIT_ON_REJECT). See rfp-vote-edits.ts for the writable-field allowlist.
    editedFields?: unknown;
    // Audit context for logging first-YES edit field changes (threaded from the route; omit in tests → no log).
    editAudit?: AuditContext;
    officeId: string | null;
    votingEnabled: boolean;
    env?: NodeJS.ProcessEnv;
  },
  deps: CastRfpVoteDeps = {},
): Promise<{ outcome: RfpVoteOutcome; votes: RfpVoteRecord[] }> {
  const env = input.env ?? process.env;
  if (input.decision !== "approve" && input.decision !== "reject") {
    throw new AppError(400, "decision must be 'approve' or 'reject'.", "RFP_VOTE_DECISION_INVALID");
  }
  const decision = input.decision;
  const rawReason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (decision === "reject" && rawReason.length === 0) {
    throw new AppError(400, "A reason is required to reject an RFP.", "RFP_VOTE_REASON_REQUIRED");
  }
  // Normalize edited fields to a plain object (a non-object/array is ignored). Edits are an approve-only affordance.
  const editedFields =
    input.editedFields != null && typeof input.editedFields === "object" && !Array.isArray(input.editedFields)
      ? (input.editedFields as RfpVoteEditableFields)
      : null;
  if (decision === "reject" && editedFields && Object.keys(editedFields).length > 0) {
    throw new AppError(400, "Edits can only accompany an approve vote.", "RFP_VOTE_EDIT_ON_REJECT");
  }
  // A soft-deleted (is_active=false) deal reads as not-found: an approve would enqueue rfp_bidboard_create the
  // bid-board-created callback (findDeal filters is_active=true) could never reconcile.
  const deal = input.deal;
  if (!deal || deal.isActive === false) throw new AppError(404, "Deal not found");
  const isOpenVoteRound =
    deal.rfpApprovalRequestEventId != null &&
    deal.rfpApprovalStatus === "pending" &&
    deal.rfpApprovalRequestId == null;
  // Authorize on the EXISTING open round, not the deal's CURRENT service classification: a non-service round edited
  // to service/type-4 mid-round would otherwise strand (pending isn't cancellable; no SyncHub request exists).
  if (isServiceRfp(deal) && !isOpenVoteRound) {
    throw new AppError(409, "Service RFPs are not decided by vote.", "RFP_VOTE_NOT_APPLICABLE");
  }
  // W7 flag-gate: an already-open round stays votable even after the flag is flipped off (rollback lever); the gate
  // only blocks a NON-open round during the rollout window (so a legacy non-service deal can't be voted on).
  if (!input.votingEnabled && !isOpenVoteRound) {
    throw new AppError(503, "RFP voting is not enabled.", "RFP_VOTING_DISABLED");
  }
  if (!isOpenVoteRound) {
    throw new AppError(409, "This deal is not in an open RFP vote round.", "RFP_NO_VOTE_ROUND");
  }
  // BC2: authorize the cast against the round's INVITED voter set (snapshotted into the rfp_vote_invitation job when
  // the round opened), not the current mutable RFP_VOTER_EMAILS — so an invited voter can still cast after the env
  // changes, and a since-added address can't. Env allowlist is the fallback only when no snapshot exists.
  const inviteSnap = await input.tenantDb.execute(sql`
    SELECT payload->'recipients' AS recipients
      FROM public.job_queue
     WHERE job_type = 'rfp_vote_invitation'
       AND payload->>'dealId' = ${deal.id}
       AND payload->>'roundEventId' = ${deal.rfpApprovalRequestEventId}
     ORDER BY id DESC
     LIMIT 1`);
  const inviteRows = Array.isArray(inviteSnap) ? inviteSnap : (inviteSnap as { rows?: any[] }).rows ?? [];
  const snapshot = inviteRows[0]?.recipients;
  if (Array.isArray(snapshot) && snapshot.length > 0) {
    const invited = snapshot.map((e: unknown) => String(e).trim().toLowerCase());
    if (!invited.includes((input.user.email ?? "").trim().toLowerCase())) {
      throw new AppError(403, "You were not one of the invited voters for this RFP round.", "RFP_VOTE_NOT_INVITED");
    }
  } else if (!isRfpVoterEmail(input.user.email, env)) {
    throw new AppError(403, "Only the designated RFP voters can vote on RFPs.", "RFP_VOTER_ONLY");
  }
  return castRfpVote(
    {
      tenantDb: input.tenantDb,
      officeId: input.officeId,
      deal,
      voter: { userId: input.user.id, email: input.user.email ?? "" },
      decision,
      reason: decision === "reject" ? rawReason : null,
      editedFields: decision === "approve" ? editedFields : null,
      editAudit: input.editAudit,
    },
    deps,
  );
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
    // finding W4: clear any STALE RFP state from a prior cycle when opening a fresh round (the legacy delivery
    // path resets these too). Otherwise a lingering rfp_override_decision='denial_reconfirmed' (or a stale
    // failed/attempt marker) would be evaluated by the later Bid Board callback guards, making a 2/3-approve
    // no-op or a 2/3-reject non-actionable for review.
    rfpOverrideState: null,
    rfpOverrideError: null,
    rfpOverrideDecision: null,
    rfpOverrideReviewedAt: null,
    rfpOverrideNote: null,
    rfpBidboardAttemptAt: null,
    rfpDeclinedReason: null,
    rfpDeclinedAt: null,
    rfpConflictReason: null,
    rfpConflictWith: null,
    rfpLastAttemptError: null,
  } as const;
  const reserveConditions = [
    eq(deals.id, args.deal.id),
    eq(deals.stageId, args.deal.stageId),
    // finding: require the deal to still be ACTIVE. A deal soft-deleted between loadTriggerRfpDeal and this reserve
    // (or a stale API call targeting an inactive deal) would otherwise open a request-less round + enqueue an
    // invitation for a deal the detail/vote paths later 404 — a hidden pending round with unusable voting links.
    eq(deals.isActive, true),
    isNull(deals.rfpApprovalStatus),
    isNull(deals.rfpApprovalRequestedAt),
    eq(deals.isBidBoardOwned, false),
    or(isNull(deals.bidBoardStageSlug), eq(deals.bidBoardStageSlug, ""))!,
    eq(deals.isReadOnlyMirror, false),
    isNull(deals.readOnlySyncedAt),
    isNull(deals.bidBoardStageEnteredAt),
    isNull(deals.bidBoardMirrorSourceEnteredAt),
    // Re-assert the deal is STILL non-service at reserve time. isServiceRfp() was evaluated from the caller's
    // pre-reservation read; a concurrent edit could flip project_type/workflow_route to service (type 4) in the
    // gap. Binding both columns into the atomic reserve makes a re-typed deal 409 here instead of opening a CRM
    // 3-voter round for a service RFP (which must stay on the SyncHub service-approval path).
    args.deal.projectType == null ? isNull(deals.projectType) : eq(deals.projectType, args.deal.projectType),
    eq(deals.workflowRoute, args.deal.workflowRoute ?? "normal"),
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
    editedFields?: RfpVoteEditableFields | null;
    editAudit?: AuditContext;
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
  // Read the guard columns AND the editable columns under the lock — the edit diff (below) must be computed against
  // the FRESH row, not the route's pre-lock snapshot, so a stale client resubmitting values another voter already
  // committed is seen as a no-op instead of a spurious RFP_VOTE_ALREADY_LOCKED.
  const lockedRes: any = await args.tenantDb.execute(
    sql`SELECT is_active, rfp_approval_status, rfp_approval_request_id, rfp_approval_request_event_id,
               name, deal_number, project_number, project_type, bid_estimate, awarded_amount, dd_estimate,
               forecast_revenue, estimator, description, bid_due_date, source_lead_id,
               property_address, property_city, property_state, property_zip, property_country
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
  // voter can POST a valid vote row that never triggers an action but silently lands in rfp_votes. Checked
  // BEFORE the open-status check so a reject-decided round (status now 'declined') still returns the specific
  // RFP_ROUND_DECIDED rather than the generic not-open error.
  if (priorState.outcome !== "pending") {
    throw new AppError(409, "This RFP vote round has already been decided.", "RFP_ROUND_DECIDED");
  }
  // finding W2: after ruling out a decided round, the round must still be OPEN ('pending'). The invitation
  // dead-letter sweep can flip an UNDECIDED round to send_failed in the route→lock gap; recording a vote then
  // would (approve) enqueue a create for a send_failed deal the create callbacks/sweeps can't reconcile, or
  // (reject) no-op applyRfpDeclineToDeal while still firing the outcome.
  if (locked.rfp_approval_status !== "pending") {
    throw new AppError(409, "This deal is not in an open RFP vote round.", "RFP_NO_VOTE_ROUND");
  }

  // First-YES commits the voter's edits + locks the deal. Under the FOR UPDATE lock above, exactly one concurrent
  // approve sees priorState.approvals === 0, so exactly one commits (race-free). The edited deal is then what the
  // DECIDING approve's loadRfpPayloadDeal re-reads into the Bid Board create payload (DB-authoritative). A LATER
  // voter that still submits a REAL edit is 409'd (the round is locked once any approve exists); the client renders
  // the committed values read-only. buildRfpVoteDealUpdate throws RFP_VOTE_SERVICE_TYPE_BLOCKED /
  // RFP_VOTE_EDIT_INVALID for a blocked or malformed edit, rolling back the whole vote (nothing recorded).
  const editedFields = args.editedFields ?? null;
  if (editedFields && Object.keys(editedFields).length > 0) {
    if (args.decision !== "approve") {
      throw new AppError(400, "Edits can only accompany an approve vote.", "RFP_VOTE_EDIT_ON_REJECT");
    }
    // Compute the REAL diff first (this also VALIDATES → RFP_VOTE_SERVICE_TYPE_BLOCKED / RFP_VOTE_EDIT_INVALID).
    // Only a genuine change locks the round + commits: an all-no-op edit set (a stale/untouched client resubmitting
    // the deal's CURRENT values — the client always posts the full field map) falls through and records a plain
    // vote, so a late deciding approve is NOT bounced with RFP_VOTE_ALREADY_LOCKED for having changed nothing.
    // Diff against the FRESH locked row (not args.deal, the route's pre-lock snapshot).
    const lockedDeal = {
      name: locked.name,
      projectNumber: locked.project_number,
      projectType: locked.project_type,
      bidEstimate: locked.bid_estimate,
      awardedAmount: locked.awarded_amount,
      ddEstimate: locked.dd_estimate,
      forecastRevenue: locked.forecast_revenue,
      estimator: locked.estimator,
      description: locked.description,
      bidDueDate: locked.bid_due_date,
      propertyAddress: locked.property_address,
      propertyCity: locked.property_city,
      propertyState: locked.property_state,
      propertyZip: locked.property_zip,
      propertyCountry: locked.property_country,
    };
    const dealUpdate = buildRfpVoteDealUpdate(editedFields, lockedDeal);
    if (Object.keys(dealUpdate).length > 0) {
      if (priorState.approvals > 0) {
        throw new AppError(
          409,
          "This RFP has already been confirmed by an earlier approval; its details are locked.",
          "RFP_VOTE_ALREADY_LOCKED",
        );
      }
      // Resolve the canonical project_type_config id for a changed type (mirrors updateDeal), so BOTH the deals-list
      // `d.project_type_id` filter AND getDealDetail's COALESCE(config.name, project_type) display track the new type
      // — instead of a stale id (old type) or a null id (deal drops out of type-filtered lists).
      if (typeof dealUpdate.projectType === "string") {
        dealUpdate.projectTypeId = await resolveProjectTypeConfigId(args.tenantDb, dealUpdate.projectType);
      }
      try {
        await writeRfpVoteDealUpdate(args.tenantDb, args.deal.id, dealUpdate);
      } catch (err) {
        // A voter-entered project number that collides with another non-change-order deal hits
        // deals_project_number_uidx — translate the 23505 into a clean 409 instead of an opaque 500.
        if (isUniqueViolation(err)) {
          throw new AppError(409, "That project number is already used by another deal.", "RFP_VOTE_PROJECT_NUMBER_TAKEN");
        }
        throw err;
      }
      // Dedicated description change-log (the detail description-history panel reads deal_history rows, which the
      // raw write above does not touch) — only when the description actually changed.
      if (dealUpdate.description !== undefined) {
        await recordDescriptionHistoryChange(args.tenantDb, {
          dealId: args.deal.id,
          oldDescription: lockedDeal.description,
          newDescription: dealUpdate.description as string,
          changedBy: args.voter.userId,
          source: "rfp_vote_edit",
        });
      }
      // getDealDetail resolves bid_due_date LEAD-FIRST for a converted deal, but the create payload reads it
      // deal-first — so for a source-lead deal also sync the lead's bid_due_date, else the committed date reaches the
      // create payload but the locked/read-only form + detail keep showing the lead's OLD date to remaining voters.
      if (dealUpdate.bidDueDate !== undefined && locked.source_lead_id) {
        const ymd = (dealUpdate.bidDueDate as Date).toISOString().slice(0, 10);
        await args.tenantDb.update(leads).set({ bidDueDate: ymd }).where(eq(leads.id, locked.source_lead_id as string));
      }
      // Re-geocode on an address change (mirrors updateDeal) — the raw write updates the address text but not the
      // deals lat/lng, so /deals/nearby + map/distance features would otherwise keep using stale coordinates. Awaited
      // (unlike updateDeal's fire-and-forget) so it commits atomically with the vote on this still-open tenant txn.
      if ("propertyAddress" in dealUpdate || "propertyCity" in dealUpdate || "propertyState" in dealUpdate) {
        const addr = (dealUpdate.propertyAddress ?? lockedDeal.propertyAddress) as string | null;
        const city = (dealUpdate.propertyCity ?? lockedDeal.propertyCity) as string | null;
        const state = (dealUpdate.propertyState ?? lockedDeal.propertyState) as string | null;
        const zip = (dealUpdate.propertyZip ?? lockedDeal.propertyZip) as string | null;
        if (addr) {
          await args.tenantDb.insert(jobQueue).values({
            jobType: "geocode_deal",
            payload: { dealId: args.deal.id, address: `${addr}, ${city || ""} ${state || ""} ${zip || ""}`.trim() },
            officeId: args.officeId ?? null,
            status: "pending",
            runAfter: new Date(),
          });
        }
      }
      // Forensic trail: this authorized write bypasses updateDeal's activity log, so record the field changes here
      // (mirrors updateDeal's logActivity). Audit context is threaded from the route; absent in direct-service tests,
      // where it's skipped.
      if (args.editAudit) {
        // The DERIVED side-effect columns — the resolved project_type_id and the amount mirror-override flags — are
        // not part of lockedDeal, so their true baseline is unknown here. Skip them so the audit records the voter's
        // ACTUAL field changes (name, project number/type, amount, …) with real from→to values, not a misleading
        // from:null.
        const AUDIT_SKIP = new Set(["projectTypeId", "awardedAmountOverridden", "ddEstimateOverridden"]);
        const fieldChanges: Record<string, RawAuditFieldChange> = {};
        for (const [field, to] of Object.entries(dealUpdate)) {
          if (AUDIT_SKIP.has(field)) continue;
          fieldChanges[field] = { from: (lockedDeal as Record<string, unknown>)[field] ?? null, to: to ?? null };
        }
        await logActivity({
          tenantDb: args.tenantDb,
          actor: args.editAudit.actor,
          action: "update",
          entity: {
            tableName: "deals",
            entityType: "deal",
            recordId: args.deal.id,
            nameSnapshot: lockedDeal.name,
            secondaryIdSnapshot: lockedDeal.projectNumber ?? (locked.deal_number as string | null) ?? null,
          },
          fieldChanges,
          metadata: { source: "rfp_vote_edit", roundEventId },
          ipAddress: args.editAudit.ipAddress ?? null,
          userAgent: args.editAudit.userAgent ?? null,
        });
      }
    }
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

/**
 * Resolve the public.project_type_config id for a project-type VALUE (the lowercased type name — e.g. "roofing").
 * A vote edit that changes deals.project_type must also update project_type_id so the deals-list `d.project_type_id`
 * filter and getDealDetail's COALESCE(config.name, project_type) display track the new type (mirrors updateDeal's
 * applyProjectTypeChange). Best-effort: returns null when the type has no active config row — display still resolves
 * via deals.project_type, and a null id is preferable to a STALE id pointing at the old type.
 */
async function resolveProjectTypeConfigId(tenantDb: TenantDb, value: string): Promise<string | null> {
  const res: any = await tenantDb.execute(
    sql`SELECT id FROM public.project_type_config
          WHERE lower(name) = ${value} AND is_active = true
          ORDER BY (parent_id IS NULL) DESC, display_order ASC NULLS LAST
          LIMIT 1`,
  );
  const rows = Array.isArray(res) ? res : res.rows ?? [];
  return (rows[0]?.id as string | null) ?? null;
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
