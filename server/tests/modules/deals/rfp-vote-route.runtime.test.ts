import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { deals } from "@trock-crm/shared/schema";
import { authorizeAndCastRfpVote } from "../../../src/modules/deals/rfp-vote-service.js";
import { isRfpVotingEnabled } from "../../../src/config/feature-flags.js";

const DEAL = "00000000-0000-0000-0000-0000000000d1";
const VOTER = { id: "00000000-0000-0000-0000-000000000001", email: "sidney@x.com" };
const NON_VOTER = { id: "00000000-0000-0000-0000-000000000009", email: "nobody@x.com" };
const ROUND = "00000000-0000-0000-0000-0000000000e1";

// Two designated voters so a second distinct voter can be simulated in one round.
// ENABLE_RFP_VOTING on by default so the flag-gate lets the happy paths through; the 503 case flips it off.
const ENV = { RFP_VOTER_EMAILS: "sidney@x.com,james@x.com,tim@x.com", ENABLE_RFP_VOTING: "true", NODE_ENV: "test" } as any;

let pg: PGlite | null = null;
afterEach(async () => { await pg?.close(); pg = null; delete process.env.RFP_VOTER_EMAILS; delete process.env.ENABLE_RFP_VOTING; });

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
      bid_estimate numeric(14,2), awarded_amount numeric(14,2), dd_estimate numeric(14,2), estimator text,
      description text, bid_due_date timestamptz, source_lead_id uuid,
      property_address text, property_city text, property_state text, property_zip text, property_country text,
      project_type text, workflow_route text NOT NULL DEFAULT 'normal', is_bid_board_owned boolean NOT NULL DEFAULT false,
      bid_board_stage_slug text, is_read_only_mirror boolean NOT NULL DEFAULT false, read_only_synced_at timestamptz,
      bid_board_stage_entered_at timestamptz, bid_board_mirror_source_entered_at timestamptz, rfp_approval_status text,
      rfp_approval_requested_at timestamptz, rfp_approval_request_event_id uuid, rfp_approval_requested_by uuid,
      rfp_approval_request_id integer, rfp_declined_reason text, rfp_declined_at timestamptz, updated_at timestamptz,
      is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE rfp_votes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deal_id uuid NOT NULL, round_event_id uuid NOT NULL, voter_user_id uuid, voter_email text NOT NULL, decision text NOT NULL, reason text, created_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT rfp_votes_deal_round_voter_uq UNIQUE (deal_id, round_event_id, voter_user_id));
  `);
  await db.query(`INSERT INTO deals (id, name, deal_number, stage_id, workflow_route, rfp_approval_status, rfp_approval_request_event_id) VALUES ($1, 'd', 'TR-1', '00000000-0000-0000-0000-0000000000aa', 'normal', 'pending', $2)`, [DEAL, ROUND]);
  return db;
}

// The route calls the SHARED authorizeAndCastRfpVote (rfp-vote-service) — the same function the production
// /deals/:id/rfp-vote route uses — so this test can't drift from the real handler. The app just resolves the deal
// (selective columns to fit the minimal DDL) + wires req context, then delegates all validation/gating/authz/cast.
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
  app.post("/deals/:id/rfp-vote", async (req: any, res, next) => {
    try {
      // Selective columns only — avoids selecting Drizzle-schema columns absent from the minimal test DDL. The real
      // route uses loadTriggerRfpDeal (full select), which works because the real DB has every column.
      const [deal] = await req.tenantDb.select({
        id: deals.id, name: deals.name, dealNumber: deals.dealNumber, projectNumber: deals.projectNumber,
        workflowRoute: deals.workflowRoute, projectType: deals.projectType,
        rfpApprovalStatus: deals.rfpApprovalStatus, rfpApprovalRequestEventId: deals.rfpApprovalRequestEventId,
        rfpApprovalRequestId: deals.rfpApprovalRequestId, isActive: deals.isActive,
      }).from(deals).where(eq(deals.id, req.params.id)).limit(1);
      const officeId = req.user.activeOfficeId ?? req.user.officeId ?? null;
      const result = await authorizeAndCastRfpVote({
        tenantDb: req.tenantDb,
        deal: deal as any,
        user: { id: req.user.id, email: req.user.email },
        decision: req.body?.decision,
        reason: req.body?.reason,
        officeId,
        votingEnabled: isRfpVotingEnabled(),
      });
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

  it("503 RFP_VOTING_DISABLED when the flag is off AND the deal is NOT already an open round (W7 rollout gate)", async () => {
    pg = await setup();
    // Make the deal a NON-open round (a legacy request-backed deal) so W7 doesn't exempt it, then flip the flag
    // off: the rollout gate blocks the cast. (An ALREADY-open round would stay votable — covered by W7.)
    await pg.query(`UPDATE deals SET rfp_approval_request_id = 42 WHERE id = $1`, [DEAL]);
    const app = buildApp(pg, VOTER);
    process.env.ENABLE_RFP_VOTING = "false";
    const res = await request(app).post(`/deals/${DEAL}/rfp-vote`).send({ decision: "approve" });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("RFP_VOTING_DISABLED");
    // Nothing was recorded — the cast never ran.
    const votes = (await pg.query(`SELECT decision FROM rfp_votes WHERE deal_id=$1`, [DEAL])).rows as any[];
    expect(votes).toHaveLength(0);
  });

  it("[finding] a deal RECLASSIFIED to service while its round is OPEN can still be voted on (not stranded)", async () => {
    pg = await setup();
    // The round is open (pending, request-less), but the deal was edited to the service route after it opened.
    // The cast must authorize on the open round, not the current service classification.
    await pg.query(`UPDATE deals SET workflow_route = 'service' WHERE id = $1`, [DEAL]);
    const res = await request(buildApp(pg, VOTER)).post(`/deals/${DEAL}/rfp-vote`).send({ decision: "approve" });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("pending");
    const votes = (await pg.query(`SELECT decision FROM rfp_votes WHERE deal_id=$1`, [DEAL])).rows as any[];
    expect(votes).toHaveLength(1);
  });

  it("[W7] an ALREADY-open round stays votable even with the flag flipped off (rollback lever)", async () => {
    pg = await setup();
    const app = buildApp(pg, VOTER);
    process.env.ENABLE_RFP_VOTING = "false";
    const res = await request(app).post(`/deals/${DEAL}/rfp-vote`).send({ decision: "approve" });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("pending");
  });

  it("[BC2] a snapshot-invited voter can still cast after being dropped from the current env allowlist", async () => {
    pg = await setup();
    // The round snapshotted [sidney, james, tim] as invited when it opened...
    await pg.query(
      `INSERT INTO public.job_queue (job_type, payload, status) VALUES ('rfp_vote_invitation', $1::jsonb, 'pending')`,
      [JSON.stringify({ dealId: DEAL, roundEventId: ROUND, recipients: ["sidney@x.com", "james@x.com", "tim@x.com"] })]
    );
    const app = buildApp(pg, VOTER); // VOTER = sidney
    // ...but sidney has since been removed from RFP_VOTER_EMAILS. The snapshot is authoritative, so the cast wins.
    process.env.RFP_VOTER_EMAILS = "james@x.com,tim@x.com";
    const res = await request(app).post(`/deals/${DEAL}/rfp-vote`).send({ decision: "approve" });
    expect(res.status).toBe(200);
    const votes = (await pg.query(`SELECT decision FROM rfp_votes WHERE deal_id=$1`, [DEAL])).rows as any[];
    expect(votes).toHaveLength(1);
  });

  it("[BC2] an env-allowlisted user who was NOT invited to the round cannot cast", async () => {
    pg = await setup();
    // The round only invited [james, tim]; sidney is in the env allowlist but was never invited to THIS round.
    await pg.query(
      `INSERT INTO public.job_queue (job_type, payload, status) VALUES ('rfp_vote_invitation', $1::jsonb, 'pending')`,
      [JSON.stringify({ dealId: DEAL, roundEventId: ROUND, recipients: ["james@x.com", "tim@x.com"] })]
    );
    const app = buildApp(pg, VOTER); // VOTER = sidney (in env, not in snapshot)
    const res = await request(app).post(`/deals/${DEAL}/rfp-vote`).send({ decision: "approve" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("RFP_VOTE_NOT_INVITED");
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

  it("409 RFP_NO_VOTE_ROUND for a legacy deal that has a SyncHub rfp_approval_request_id (non-null)", async () => {
    pg = await setup();
    // Stamp a SyncHub request_id so the deal looks like a legacy single-approver deal.
    await pg.query(`UPDATE deals SET rfp_approval_request_id = 42 WHERE id = $1`, [DEAL]);
    const res = await request(buildApp(pg, VOTER)).post(`/deals/${DEAL}/rfp-vote`).send({ decision: "approve" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("RFP_NO_VOTE_ROUND");
    // No vote row must be inserted — the guard fires before castRfpVote.
    const votes = (await pg.query(`SELECT decision FROM rfp_votes WHERE deal_id=$1`, [DEAL])).rows as any[];
    expect(votes).toHaveLength(0);
  });

  it("404 for a soft-deleted (is_active=false) deal — no vote recorded", async () => {
    pg = await setup();
    // Soft-delete the deal (the canonical delete marker). A vote must be refused before castRfpVote so an
    // approve can't enqueue a create the bid-board-created callback (is_active=true) could never reconcile.
    await pg.query(`UPDATE deals SET is_active = false WHERE id = $1`, [DEAL]);
    const res = await request(buildApp(pg, VOTER)).post(`/deals/${DEAL}/rfp-vote`).send({ decision: "approve" });
    expect(res.status).toBe(404);
    const votes = (await pg.query(`SELECT decision FROM rfp_votes WHERE deal_id=$1`, [DEAL])).rows as any[];
    expect(votes).toHaveLength(0);
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
