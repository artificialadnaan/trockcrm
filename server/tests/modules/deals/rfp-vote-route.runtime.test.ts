import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { deals, rfpVotes } from "@trock-crm/shared/schema";
import { requireRfpVoter } from "../../../src/middleware/rbac.js";
import { castRfpVote, isServiceRfp } from "../../../src/modules/deals/rfp-vote-service.js";
import { AppError } from "../../../src/middleware/error-handler.js";
import { isRfpVotingEnabled } from "../../../src/config/feature-flags.js";

const DEAL = "00000000-0000-0000-0000-0000000000d1";
const VOTER = { id: "00000000-0000-0000-0000-000000000001", email: "sidney@x.com" };
const NON_VOTER = { id: "00000000-0000-0000-0000-000000000009", email: "nobody@x.com" };
const ROUND = "00000000-0000-0000-0000-0000000000e1";

// Two designated voters so a second distinct voter can be simulated in one round.
// ENABLE_RFP_VOTING on by default so the flag-gate lets the happy paths through; the 503 case flips it off.
const ENV = { RFP_VOTER_EMAILS: "sidney@x.com,james@x.com,tim@x.com", ENABLE_RFP_VOTING: "true", NODE_ENV: "test" } as any;

let pg: PGlite | null = null;
afterEach(async () => { await pg?.close(); pg = null; process.env.RFP_VOTER_EMAILS = undefined as any; process.env.ENABLE_RFP_VOTING = undefined as any; });

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
      id uuid PRIMARY KEY, name text NOT NULL, deal_number text NOT NULL, project_number text, stage_id uuid,
      project_type text, workflow_route text NOT NULL DEFAULT 'normal', is_bid_board_owned boolean NOT NULL DEFAULT false,
      bid_board_stage_slug text, is_read_only_mirror boolean NOT NULL DEFAULT false, read_only_synced_at timestamptz,
      bid_board_stage_entered_at timestamptz, bid_board_mirror_source_entered_at timestamptz, rfp_approval_status text,
      rfp_approval_requested_at timestamptz, rfp_approval_request_event_id uuid, rfp_approval_requested_by uuid,
      rfp_approval_request_id integer, rfp_declined_reason text, rfp_declined_at timestamptz, updated_at timestamptz
    );
    CREATE TABLE rfp_votes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deal_id uuid NOT NULL, round_event_id uuid NOT NULL, voter_user_id uuid, voter_email text NOT NULL, decision text NOT NULL, reason text, created_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT rfp_votes_deal_round_voter_uq UNIQUE (deal_id, round_event_id, voter_user_id));
  `);
  await db.query(`INSERT INTO deals (id, name, deal_number, stage_id, workflow_route, rfp_approval_status, rfp_approval_request_event_id) VALUES ($1, 'd', 'TR-1', '00000000-0000-0000-0000-0000000000aa', 'normal', 'pending', $2)`, [DEAL, ROUND]);
  return db;
}

// Mirror of the production route body (same handler code) so the test exercises validation + middleware.
// Note: uses a selective column query instead of select().from(deals) to avoid hitting Drizzle columns that
// don't exist in the minimal test DDL. The production route uses loadTriggerRfpDeal (full select) which works
// fine because the real DB has all columns.
function buildApp(pgDb: PGlite, user: { id: string; email: string }) {
  const app = express();
  app.use(express.json());
  Object.assign(process.env, ENV);
  app.use((req: any, _res, next) => {
    req.user = { ...user, role: "rep", activeOfficeId: "00000000-0000-0000-0000-0000000000ff", officeId: "00000000-0000-0000-0000-0000000000ff" };
    req.tenantDb = drizzle(pgDb as any);
    req.commitTransaction = async () => {};
    next();
  });
  app.post("/deals/:id/rfp-vote", requireRfpVoter, async (req: any, res, next) => {
    try {
      // Mirror of the production flag-gate: the cast is inert while ENABLE_RFP_VOTING is off.
      if (!isRfpVotingEnabled()) throw new AppError(503, "RFP voting is not enabled.", "RFP_VOTING_DISABLED");
      const decision = req.body?.decision;
      if (decision !== "approve" && decision !== "reject") throw new AppError(400, "decision must be 'approve' or 'reject'.", "RFP_VOTE_DECISION_INVALID");
      const rawReason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
      if (decision === "reject" && rawReason.length === 0) throw new AppError(400, "A reason is required to reject an RFP.", "RFP_VOTE_REASON_REQUIRED");
      // Selective columns only — avoids selecting Drizzle-schema columns absent from the minimal test DDL.
      const [deal] = await req.tenantDb.select({
        id: deals.id, name: deals.name, dealNumber: deals.dealNumber, projectNumber: deals.projectNumber,
        workflowRoute: deals.workflowRoute, projectType: deals.projectType,
        rfpApprovalStatus: deals.rfpApprovalStatus, rfpApprovalRequestEventId: deals.rfpApprovalRequestEventId,
        rfpApprovalRequestId: deals.rfpApprovalRequestId,
      }).from(deals).where(eq(deals.id, req.params.id)).limit(1);
      if (!deal) throw new AppError(404, "Deal not found");
      if (isServiceRfp(deal)) throw new AppError(409, "Service RFPs are not decided by vote.", "RFP_VOTE_NOT_APPLICABLE");
      if (!deal.rfpApprovalRequestEventId || deal.rfpApprovalStatus !== "pending") throw new AppError(409, "This deal is not in an open RFP vote round.", "RFP_NO_VOTE_ROUND");
      const officeId = req.user.activeOfficeId ?? req.user.officeId ?? null;
      const result = await castRfpVote({ tenantDb: req.tenantDb, officeId, deal, voter: { userId: req.user.id, email: req.user.email }, decision, reason: decision === "reject" ? rawReason : null });
      await req.commitTransaction();
      res.json({ success: true, outcome: result.outcome, votes: result.votes });
    } catch (err) { next(err); }
  });
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? 500).json({ error: err.message, code: err.code }));
  return app;
}

describe("POST /deals/:id/rfp-vote", () => {
  it("403 for a non-voter", async () => {
    pg = await setup();
    const res = await request(buildApp(pg, NON_VOTER)).post(`/deals/${DEAL}/rfp-vote`).send({ decision: "approve" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("RFP_VOTER_ONLY");
  });

  it("503 RFP_VOTING_DISABLED when ENABLE_RFP_VOTING is not 'true' (a voter can't cast during the rollout window)", async () => {
    pg = await setup();
    const app = buildApp(pg, VOTER);
    // buildApp seeds ENABLE_RFP_VOTING='true' via ENV; flip it off AFTER build so the request-time check trips.
    process.env.ENABLE_RFP_VOTING = "false";
    const res = await request(app).post(`/deals/${DEAL}/rfp-vote`).send({ decision: "approve" });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("RFP_VOTING_DISABLED");
    // Nothing was recorded — the cast never ran.
    const votes = (await pg.query(`SELECT decision FROM rfp_votes WHERE deal_id=$1`, [DEAL])).rows as any[];
    expect(votes).toHaveLength(0);
  });

  it("400 when rejecting without a reason", async () => {
    pg = await setup();
    const res = await request(buildApp(pg, VOTER)).post(`/deals/${DEAL}/rfp-vote`).send({ decision: "reject" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("RFP_VOTE_REASON_REQUIRED");
  });

  it("happy-path approve records a pending vote", async () => {
    pg = await setup();
    const res = await request(buildApp(pg, VOTER)).post(`/deals/${DEAL}/rfp-vote`).send({ decision: "approve" });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("pending");
    const votes = (await pg.query(`SELECT decision FROM rfp_votes WHERE deal_id=$1`, [DEAL])).rows as any[];
    expect(votes).toHaveLength(1);
    expect(votes[0].decision).toBe("approve");
  });

  it("409 when the same voter votes twice (locked on cast)", async () => {
    pg = await setup();
    const app = buildApp(pg, VOTER);
    await request(app).post(`/deals/${DEAL}/rfp-vote`).send({ decision: "approve" });
    const res = await request(app).post(`/deals/${DEAL}/rfp-vote`).send({ decision: "reject", reason: "changed my mind" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("RFP_ALREADY_VOTED");
  });
});
