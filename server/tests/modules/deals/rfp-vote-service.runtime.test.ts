import { afterEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
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
      updated_at timestamptz
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
  it("approve-majority enqueues rfp_bidboard_create exactly once (2nd fires, 3rd does not)", async () => {
    pg = await setup();
    const tdb: any = drizzle(pg as any);
    const enqueueBidBoardCreate = vi.fn(async () => ({ jobId: 1 }));

    const r1 = await castRfpVote(
      { tenantDb: tdb, officeId: "00000000-0000-0000-0000-0000000000ff", deal: dealRow(), voter: { userId: V1, email: "sidney@x.com" }, decision: "approve", reason: null },
      { enqueueBidBoardCreate },
    );
    expect(r1.outcome).toBe("pending");
    const r2 = await castRfpVote(
      { tenantDb: tdb, officeId: "00000000-0000-0000-0000-0000000000ff", deal: dealRow(), voter: { userId: V2, email: "james@x.com" }, decision: "approve", reason: null },
      { enqueueBidBoardCreate },
    );
    expect(r2.outcome).toBe("approved");
    const r3 = await castRfpVote(
      { tenantDb: tdb, officeId: "00000000-0000-0000-0000-0000000000ff", deal: dealRow(), voter: { userId: V3, email: "tim@x.com" }, decision: "approve", reason: null },
      { enqueueBidBoardCreate },
    );
    expect(r3.outcome).toBe("approved");
    expect(enqueueBidBoardCreate).toHaveBeenCalledTimes(1);
  });

  it("reject-majority calls applyDecline with the aggregated reason and flips status to declined", async () => {
    pg = await setup();
    const tdb: any = drizzle(pg as any);
    const applyDecline = vi.fn(async (input: any) => {
      await pg!.query(`UPDATE deals SET rfp_approval_status='declined', rfp_declined_reason=$1 WHERE id=$2`, [input.denialReason, input.sourceDealId]);
      return { applied: true, declinedDeal: null };
    });

    await castRfpVote(
      { tenantDb: tdb, officeId: "00000000-0000-0000-0000-0000000000ff", deal: dealRow(), voter: { userId: V1, email: "sidney@x.com" }, decision: "reject", reason: "Margins too thin" },
      { applyDecline },
    );
    const res = await castRfpVote(
      { tenantDb: tdb, officeId: "00000000-0000-0000-0000-0000000000ff", deal: dealRow(), voter: { userId: V2, email: "james@x.com" }, decision: "reject", reason: "Scope unclear" },
      { applyDecline },
    );
    expect(res.outcome).toBe("rejected");
    expect(applyDecline).toHaveBeenCalledTimes(1);
    expect(applyDecline.mock.calls[0][0].denialReason).toBe(
      "Rejected by vote (2 of 3). sidney@x.com: Margins too thin; james@x.com: Scope unclear",
    );
    const rows = (await pg!.query(`SELECT rfp_approval_status, rfp_declined_reason FROM deals WHERE id=$1`, [DEAL])).rows as any[];
    expect(rows[0].rfp_approval_status).toBe("declined");
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
});
