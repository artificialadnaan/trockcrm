import { afterEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  allRfpVotersHaveOfficeAccess,
  castRfpVote,
  isServiceRfp,
  buildRfpVoteDeclineReason,
  openRfpVoteRound,
} from "../../../src/modules/deals/rfp-vote-service.js";

/**
 * REAL-SQL (PGlite) proof of the vote engine. rfp_votes + deals live in the DEFAULT (public) schema so the
 * bare pgTable Drizzle mappings resolve unqualified (mirrors floor-gate.runtime.test.ts). The reject path
 * injects an `applyDecline` stub that (a) records the aggregated reason and (b) flips public.deals to
 * 'declined', so we assert the call + the transition without needing office_x.deals for applyRfpDeclineToDeal.
 */
const DEAL = "00000000-0000-0000-0000-0000000000d1";
const V1 = "00000000-0000-0000-0000-000000000001";
const V2 = "00000000-0000-0000-0000-000000000002";
const V3 = "00000000-0000-0000-0000-000000000003";
const ROUND = "00000000-0000-0000-0000-0000000000e1";

let pg: PGlite | null = null;
afterEach(async () => {
  await pg?.close();
  pg = null;
});

async function setup() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE public.job_queue (
      id bigserial PRIMARY KEY, job_type text NOT NULL, payload jsonb NOT NULL, office_id uuid,
      status text NOT NULL, attempts integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 3,
      last_error text, started_processing_at timestamptz,
      run_after timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz
    );
    CREATE TABLE public.offices (id uuid PRIMARY KEY, slug text NOT NULL, is_active boolean NOT NULL DEFAULT true);
    INSERT INTO public.offices (id, slug) VALUES ('00000000-0000-0000-0000-0000000000ff', 'test');
    CREATE TABLE deals (
      id uuid PRIMARY KEY, name text NOT NULL, deal_number text NOT NULL, project_number text,
      stage_id uuid, project_type text, workflow_route text NOT NULL DEFAULT 'normal',
      is_bid_board_owned boolean NOT NULL DEFAULT false, bid_board_stage_slug text,
      is_read_only_mirror boolean NOT NULL DEFAULT false, read_only_synced_at timestamptz,
      bid_board_stage_entered_at timestamptz, bid_board_mirror_source_entered_at timestamptz,
      rfp_approval_status text, rfp_approval_requested_at timestamptz,
      rfp_approval_request_event_id uuid, rfp_approval_requested_by uuid,
      rfp_approval_request_id integer, rfp_declined_reason text, rfp_declined_at timestamptz,
      rfp_override_state text, rfp_override_error text, rfp_override_decision text, rfp_override_note text,
      rfp_override_reviewed_at timestamptz, rfp_bidboard_attempt_at timestamptz, rfp_conflict_reason text,
      rfp_conflict_with jsonb, rfp_last_attempt_error text,
      is_active boolean NOT NULL DEFAULT true, updated_at timestamptz
    );
    CREATE TABLE rfp_votes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deal_id uuid NOT NULL, round_event_id uuid NOT NULL,
      voter_user_id uuid, voter_email text NOT NULL, decision text NOT NULL, reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT rfp_votes_deal_round_voter_uq UNIQUE (deal_id, round_event_id, voter_user_id)
    );
  `);
  await db.query(
    `INSERT INTO deals (id, name, deal_number, stage_id, workflow_route, rfp_approval_status, rfp_approval_request_event_id)
     VALUES ($1, 'jasonn ranches', 'TR-1001', '00000000-0000-0000-0000-0000000000aa', 'normal', 'pending', $2)`,
    [DEAL, ROUND],
  );
  return db;
}

function dealRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DEAL,
    name: "jasonn ranches",
    dealNumber: "TR-1001",
    projectNumber: null,
    stageId: "00000000-0000-0000-0000-0000000000aa",
    workflowRoute: "normal",
    projectType: null,
    rfpApprovalStatus: "pending",
    rfpApprovalRequestEventId: ROUND,
    rfpApprovalRequestId: null,
    ...overrides,
  } as any;
}

describe("isServiceRfp", () => {
  it("is true only for the service route (code 4)", () => {
    expect(isServiceRfp({ workflowRoute: "service" })).toBe(true);
    expect(isServiceRfp({ workflowRoute: "normal" })).toBe(false);
    expect(isServiceRfp({ projectType: "roofing", workflowRoute: "normal" })).toBe(false);
  });
});

describe("buildRfpVoteDeclineReason", () => {
  it("aggregates the reject reasons as '(N of 3)'", () => {
    const reason = buildRfpVoteDeclineReason([
      { voterUserId: V2, voterEmail: "james@x.com", decision: "reject", reason: "Margins too thin", createdAt: new Date() },
      { voterUserId: V1, voterEmail: "sidney@x.com", decision: "reject", reason: "  Scope unclear ", createdAt: new Date() },
    ]);
    expect(reason).toBe("Rejected by vote (2 of 3). james@x.com: Margins too thin; sidney@x.com: Scope unclear");
  });
});

describe("castRfpVote", () => {
  it("approve-majority enqueues rfp_bidboard_create exactly once (2nd fires, 3rd is rejected)", async () => {
    pg = await setup();
    const tdb: any = drizzle(pg as any);
    const enqueueBidBoardCreate = vi.fn(async () => ({ jobId: 1 }));
    const enqueueOutcome = vi.fn(async () => ({ jobId: 99 }));

    const r1 = await castRfpVote(
      { tenantDb: tdb, officeId: "00000000-0000-0000-0000-0000000000ff", deal: dealRow(), voter: { userId: V1, email: "sidney@x.com" }, decision: "approve", reason: null },
      { enqueueBidBoardCreate, enqueueOutcome },
    );
    expect(r1.outcome).toBe("pending");
    const r2 = await castRfpVote(
      { tenantDb: tdb, officeId: "00000000-0000-0000-0000-0000000000ff", deal: dealRow(), voter: { userId: V2, email: "james@x.com" }, decision: "approve", reason: null },
      { enqueueBidBoardCreate, enqueueOutcome },
    );
    expect(r2.outcome).toBe("approved");
    // 3rd vote arrives after the round is already decided — must be rejected, not silently stored.
    await expect(
      castRfpVote(
        { tenantDb: tdb, officeId: "00000000-0000-0000-0000-0000000000ff", deal: dealRow(), voter: { userId: V3, email: "tim@x.com" }, decision: "approve", reason: null },
        { enqueueBidBoardCreate, enqueueOutcome },
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "RFP_ROUND_DECIDED" });
    expect(enqueueBidBoardCreate).toHaveBeenCalledTimes(1);
    // The outcome-email enqueue (rep GO notification) must also fire exactly once, on the deciding vote.
    expect(enqueueOutcome).toHaveBeenCalledTimes(1);
    expect(enqueueOutcome.mock.calls[0][0]).toMatchObject({ outcome: "approved", approvals: 2 });
    // No 3rd row was inserted.
    const rows = (await pg!.query(`SELECT voter_user_id FROM rfp_votes WHERE deal_id=$1`, [DEAL])).rows as any[];
    expect(rows).toHaveLength(2);
  });

  it("reject-majority calls applyDecline with the aggregated reason and flips status to declined", async () => {
    pg = await setup();
    const tdb: any = drizzle(pg as any);
    const applyDecline = vi.fn(async (input: any) => {
      await pg!.query(`UPDATE deals SET rfp_approval_status='declined', rfp_declined_reason=$1 WHERE id=$2`, [input.denialReason, input.sourceDealId]);
      return { applied: true, declinedDeal: null };
    });
    const enqueueOutcome = vi.fn(async () => ({ jobId: 99 }));

    await castRfpVote(
      { tenantDb: tdb, officeId: "00000000-0000-0000-0000-0000000000ff", deal: dealRow(), voter: { userId: V1, email: "sidney@x.com" }, decision: "reject", reason: "Margins too thin" },
      { applyDecline, enqueueOutcome },
    );
    const res = await castRfpVote(
      { tenantDb: tdb, officeId: "00000000-0000-0000-0000-0000000000ff", deal: dealRow(), voter: { userId: V2, email: "james@x.com" }, decision: "reject", reason: "Scope unclear" },
      { applyDecline, enqueueOutcome },
    );
    expect(res.outcome).toBe("rejected");
    expect(applyDecline).toHaveBeenCalledTimes(1);
    expect(applyDecline.mock.calls[0][0].denialReason).toBe(
      "Rejected by vote (2 of 3). sidney@x.com: Margins too thin; james@x.com: Scope unclear",
    );
    // The outcome-email enqueue (rep + Takashi/Adam NO-GO escalation) must fire exactly once — this is the
    // ONLY no-go escalation path (the 0148 trigger is inert for null-request-id voting declines).
    expect(enqueueOutcome).toHaveBeenCalledTimes(1);
    expect(enqueueOutcome.mock.calls[0][0]).toMatchObject({ outcome: "rejected", rejections: 2 });
    const rows = (await pg!.query(`SELECT rfp_approval_status, rfp_declined_reason FROM deals WHERE id=$1`, [DEAL])).rows as any[];
    expect(rows[0].rfp_approval_status).toBe("declined");
  });

  it("409 RFP_ROUND_DECIDED for a vote arriving after the 2-of-3 threshold is already crossed", async () => {
    pg = await setup();
    const tdb: any = drizzle(pg as any);
    const applyDecline = vi.fn(async (input: any) => {
      await pg!.query(`UPDATE deals SET rfp_approval_status='declined', rfp_declined_reason=$1 WHERE id=$2`, [input.denialReason, input.sourceDealId]);
      return { applied: true, declinedDeal: null };
    });
    const enqueueOutcome = vi.fn(async () => ({ jobId: 99 }));
    // V1 + V2 reject => round decided
    await castRfpVote(
      { tenantDb: tdb, officeId: "00000000-0000-0000-0000-0000000000ff", deal: dealRow(), voter: { userId: V1, email: "sidney@x.com" }, decision: "reject", reason: "Margins thin" },
      { applyDecline, enqueueOutcome },
    );
    await castRfpVote(
      { tenantDb: tdb, officeId: "00000000-0000-0000-0000-0000000000ff", deal: dealRow(), voter: { userId: V2, email: "james@x.com" }, decision: "reject", reason: "Scope unclear" },
      { applyDecline, enqueueOutcome },
    );
    // V3 arrives late — must be rejected BEFORE any insert
    await expect(
      castRfpVote(
        { tenantDb: tdb, officeId: "00000000-0000-0000-0000-0000000000ff", deal: dealRow(), voter: { userId: V3, email: "tim@x.com" }, decision: "approve", reason: null },
        { applyDecline, enqueueOutcome },
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "RFP_ROUND_DECIDED" });
    // applyDecline and enqueueOutcome fire exactly once (on the deciding vote, not again)
    expect(applyDecline).toHaveBeenCalledTimes(1);
    expect(enqueueOutcome).toHaveBeenCalledTimes(1);
    // Exactly 2 rows in rfp_votes — the late vote was NOT inserted
    const rows = (await pg!.query(`SELECT voter_user_id FROM rfp_votes WHERE deal_id=$1`, [DEAL])).rows as any[];
    expect(rows).toHaveLength(2);
  });

  it("second vote by the same voter -> 409 RFP_ALREADY_VOTED", async () => {
    pg = await setup();
    const tdb: any = drizzle(pg as any);
    await castRfpVote(
      { tenantDb: tdb, officeId: "00000000-0000-0000-0000-0000000000ff", deal: dealRow(), voter: { userId: V1, email: "sidney@x.com" }, decision: "approve", reason: null },
      { enqueueBidBoardCreate: vi.fn(async () => ({ jobId: 1 })) },
    );
    await expect(
      castRfpVote(
        { tenantDb: tdb, officeId: "00000000-0000-0000-0000-0000000000ff", deal: dealRow(), voter: { userId: V1, email: "sidney@x.com" }, decision: "reject", reason: "changed my mind" },
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "RFP_ALREADY_VOTED" });
  });

  it("[H3] 404s a deal soft-deleted between the route pre-check and the lock (no vote recorded, no enqueue)", async () => {
    pg = await setup();
    await pg.query(`UPDATE deals SET is_active = false WHERE id = $1`, [DEAL]);
    const tdb: any = drizzle(pg as any);
    const enqueue = vi.fn(async () => ({ jobId: 1 }));
    await expect(
      castRfpVote(
        { tenantDb: tdb, officeId: "00000000-0000-0000-0000-0000000000ff", deal: dealRow(), voter: { userId: V1, email: "sidney@x.com" }, decision: "approve", reason: null },
        { enqueueBidBoardCreate: enqueue },
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(enqueue).not.toHaveBeenCalled();
    const votes = (await pg.query(`SELECT id FROM rfp_votes WHERE deal_id=$1`, [DEAL])).rows as any[];
    expect(votes).toHaveLength(0);
  });

  it("[W2] 409 RFP_NO_VOTE_ROUND when the invitation sweep flipped an UNDECIDED round to send_failed under us", async () => {
    pg = await setup();
    // The round is still on the same event id (not cleared) but the sweep changed status pending -> send_failed.
    await pg.query(`UPDATE deals SET rfp_approval_status = 'send_failed' WHERE id = $1`, [DEAL]);
    const tdb: any = drizzle(pg as any);
    const enqueue = vi.fn(async () => ({ jobId: 1 }));
    await expect(
      castRfpVote(
        { tenantDb: tdb, officeId: "00000000-0000-0000-0000-0000000000ff", deal: dealRow(), voter: { userId: V1, email: "sidney@x.com" }, decision: "approve", reason: null },
        { enqueueBidBoardCreate: enqueue },
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "RFP_NO_VOTE_ROUND" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("[H3] 409 RFP_NO_VOTE_ROUND when the round was cleared/re-triggered (locked event id no longer matches)", async () => {
    pg = await setup();
    // Return to Opportunity between the route read and the lock: event id cleared under us.
    await pg.query(`UPDATE deals SET rfp_approval_status = NULL, rfp_approval_request_event_id = NULL WHERE id = $1`, [DEAL]);
    const tdb: any = drizzle(pg as any);
    const enqueue = vi.fn(async () => ({ jobId: 1 }));
    await expect(
      castRfpVote(
        { tenantDb: tdb, officeId: "00000000-0000-0000-0000-0000000000ff", deal: dealRow(), voter: { userId: V1, email: "sidney@x.com" }, decision: "approve", reason: null },
        { enqueueBidBoardCreate: enqueue },
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "RFP_NO_VOTE_ROUND" });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("openRfpVoteRound", () => {
  it("reserves the deal (status pending, event id) and enqueues rfp_vote_invitation", async () => {
    pg = await setup();
    // Reset the deal to a pre-round state.
    await pg.query(`UPDATE deals SET rfp_approval_status=NULL, rfp_approval_request_event_id=NULL WHERE id=$1`, [DEAL]);
    const tdb: any = drizzle(pg as any);
    await openRfpVoteRound({
      tenantDb: tdb,
      officeId: "00000000-0000-0000-0000-0000000000ff",
      deal: dealRow({ rfpApprovalStatus: null, rfpApprovalRequestEventId: null }),
      requestedByUserId: V1,
    });
    const deal = (await pg.query(`SELECT rfp_approval_status, rfp_approval_request_event_id, rfp_approval_requested_by FROM deals WHERE id=$1`, [DEAL])).rows as any[];
    expect(deal[0].rfp_approval_status).toBe("pending");
    expect(deal[0].rfp_approval_request_event_id).not.toBeNull();
    const jobs = (await pg.query(`SELECT job_type, payload FROM public.job_queue`)).rows as any[];
    expect(jobs).toHaveLength(1);
    expect(jobs[0].job_type).toBe("rfp_vote_invitation");
    expect(jobs[0].payload.dealId).toBe(DEAL);
  });

  it("409s (no round, no invitation) if the deal was re-typed to service between the caller's read and the reserve", async () => {
    pg = await setup();
    await pg.query(`UPDATE deals SET rfp_approval_status=NULL, rfp_approval_request_event_id=NULL WHERE id=$1`, [DEAL]);
    // A concurrent edit flips the deal onto the SERVICE route AFTER the caller read it as non-service.
    await pg.query(`UPDATE deals SET workflow_route='service' WHERE id=$1`, [DEAL]);
    const tdb: any = drizzle(pg as any);
    await expect(
      openRfpVoteRound({
        tenantDb: tdb,
        officeId: "00000000-0000-0000-0000-0000000000ff",
        // args.deal reflects the STALE non-service read (workflow_route 'normal').
        deal: dealRow({ rfpApprovalStatus: null, rfpApprovalRequestEventId: null, workflowRoute: "normal" }),
        requestedByUserId: V1,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "RFP_ALREADY_TRIGGERED" });
    // The service RFP must NOT get a CRM 3-voter round or an invitation.
    const deal = (await pg.query(`SELECT rfp_approval_status FROM deals WHERE id=$1`, [DEAL])).rows as any[];
    expect(deal[0].rfp_approval_status).toBeNull();
    const jobs = (await pg.query(`SELECT job_type FROM public.job_queue`)).rows as any[];
    expect(jobs).toHaveLength(0);
  });

  it("409s (no round, no invitation) if the deal was SOFT-DELETED between the caller's read and the reserve", async () => {
    pg = await setup();
    await pg.query(`UPDATE deals SET rfp_approval_status=NULL, rfp_approval_request_event_id=NULL, is_active=false WHERE id=$1`, [DEAL]);
    const tdb: any = drizzle(pg as any);
    await expect(
      openRfpVoteRound({
        tenantDb: tdb,
        officeId: "00000000-0000-0000-0000-0000000000ff",
        deal: dealRow({ rfpApprovalStatus: null, rfpApprovalRequestEventId: null }),
        requestedByUserId: V1,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "RFP_ALREADY_TRIGGERED" });
    const jobs = (await pg.query(`SELECT job_type FROM public.job_queue`)).rows as any[];
    expect(jobs).toHaveLength(0);
  });
});

describe("allRfpVotersHaveOfficeAccess", () => {
  const OFFICE = "00000000-0000-0000-0000-0000000000ff";
  const OTHER = "00000000-0000-0000-0000-0000000000fe";
  const SID = "00000000-0000-0000-0000-00000000a001";
  const TIM = "00000000-0000-0000-0000-00000000a002";
  const JAMES = "00000000-0000-0000-0000-00000000a003";
  const ENV = { RFP_VOTER_EMAILS: "sidney@x.com,tim@x.com,james@x.com" } as any;
  let apg: PGlite | null = null;
  afterEach(async () => { await apg?.close(); apg = null; });

  async function setupAccess() {
    const db = new PGlite();
    apg = db;
    await db.exec(`
      CREATE TABLE users (id uuid PRIMARY KEY, email text, office_id uuid, role text NOT NULL DEFAULT 'estimator', is_active boolean NOT NULL DEFAULT true);
      CREATE TABLE user_office_access (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, office_id uuid NOT NULL, role_override text);
    `);
    return drizzle(db as any) as any;
  }

  it("true when all three voters can access the office (primary office OR an explicit grant)", async () => {
    const tdb = await setupAccess();
    // Sidney + James: primary office = OFFICE. Tim: primary OTHER, but holds a grant to OFFICE.
    await apg!.query(`INSERT INTO users (id, email, office_id) VALUES ($1,'Sidney@x.com',$4),($2,'tim@x.com',$5),($3,'james@x.com',$4)`, [SID, TIM, JAMES, OFFICE, OTHER]);
    await apg!.query(`INSERT INTO user_office_access (id, user_id, office_id) VALUES (gen_random_uuid(), $1, $2)`, [TIM, OFFICE]);
    expect(await allRfpVotersHaveOfficeAccess(tdb, OFFICE, ENV)).toBe(true);
  });

  it("false when a voter's only office is elsewhere with no grant to this office", async () => {
    const tdb = await setupAccess();
    // Tim's primary is OTHER and he has NO grant to OFFICE -> he can't enter this tenant.
    await apg!.query(`INSERT INTO users (id, email, office_id) VALUES ($1,'sidney@x.com',$4),($2,'tim@x.com',$5),($3,'james@x.com',$4)`, [SID, TIM, JAMES, OFFICE, OTHER]);
    expect(await allRfpVotersHaveOfficeAccess(tdb, OFFICE, ENV)).toBe(false);
  });

  it("false when a configured voter isn't a CRM user at all", async () => {
    const tdb = await setupAccess();
    await apg!.query(`INSERT INTO users (id, email, office_id) VALUES ($1,'sidney@x.com',$3),($2,'james@x.com',$3)`, [SID, JAMES, OFFICE]); // no tim
    expect(await allRfpVotersHaveOfficeAccess(tdb, OFFICE, ENV)).toBe(false);
  });

  it("false when a configured voter exists for the office but is DEACTIVATED (is_active=false)", async () => {
    const tdb = await setupAccess();
    // All three have office access, but Tim is deactivated -> authMiddleware would reject him, so he can't vote.
    await apg!.query(`INSERT INTO users (id, email, office_id, is_active) VALUES ($1,'sidney@x.com',$4,true),($2,'tim@x.com',$4,false),($3,'james@x.com',$4,true)`, [SID, TIM, JAMES, OFFICE]);
    expect(await allRfpVotersHaveOfficeAccess(tdb, OFFICE, ENV)).toBe(false);
  });

  it("false when a configured voter has office access but a field_contractor EFFECTIVE role (can't pass requireCrmUser)", async () => {
    const tdb = await setupAccess();
    // All three are at OFFICE + active, but Tim's role is field_contractor -> the deals routes (requireCrmUser)
    // would 403 him, so he can neither load the ballot nor cast; he must not count toward the trio.
    await apg!.query(`INSERT INTO users (id, email, office_id, role) VALUES ($1,'sidney@x.com',$4,'estimator'),($2,'tim@x.com',$4,'field_contractor'),($3,'james@x.com',$4,'admin')`, [SID, TIM, JAMES, OFFICE]);
    expect(await allRfpVotersHaveOfficeAccess(tdb, OFFICE, ENV)).toBe(false);
  });

  it("true when a field_contractor base role is lifted to a CRM role_override for THIS granted office", async () => {
    const tdb = await setupAccess();
    // Tim's HOME (OTHER) base role is field_contractor, but he reaches OFFICE via a grant whose role_override is a
    // CRM role -> authMiddleware's effective role at OFFICE is 'estimator', so requireCrmUser passes and he counts.
    await apg!.query(`INSERT INTO users (id, email, office_id, role) VALUES ($1,'sidney@x.com',$4,'estimator'),($2,'tim@x.com',$5,'field_contractor'),($3,'james@x.com',$4,'admin')`, [SID, TIM, JAMES, OFFICE, OTHER]);
    await apg!.query(`INSERT INTO user_office_access (id, user_id, office_id, role_override) VALUES (gen_random_uuid(), $1, $2, 'estimator')`, [TIM, OFFICE]);
    expect(await allRfpVotersHaveOfficeAccess(tdb, OFFICE, ENV)).toBe(true);
  });
});
