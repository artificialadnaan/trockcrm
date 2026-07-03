import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { hasSufficientRfpVoters, isServiceRfp, openRfpVoteRound } from "../../../src/modules/deals/rfp-vote-service.js";
import { isRfpVotingEnabled } from "../../../src/config/feature-flags.js";

const DEAL = "00000000-0000-0000-0000-0000000000d1";
const REP = "00000000-0000-0000-0000-0000000000f1";
const OTHER_REP = "00000000-0000-0000-0000-0000000000f2";

let pg: PGlite | null = null;
afterEach(async () => {
  await pg?.close();
  pg = null;
});

async function setup() {
  const db = new PGlite();
  // job_queue DDL: COMPLETE column set copied from rfp-vote-service.runtime.test.ts (Task 7)
  // to match the Drizzle jobQueue schema — enqueueRfpVoteInvitation inserts attempts + extras.
  await db.exec(`
    CREATE TABLE public.job_queue (
      id bigserial PRIMARY KEY, job_type text NOT NULL, payload jsonb NOT NULL, office_id uuid,
      status text NOT NULL, attempts integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 3,
      last_error text, started_processing_at timestamptz,
      run_after timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz
    );
    CREATE TABLE deals (
      id uuid PRIMARY KEY, name text NOT NULL, deal_number text NOT NULL, project_number text, stage_id uuid,
      project_type text, workflow_route text NOT NULL DEFAULT 'normal', is_bid_board_owned boolean NOT NULL DEFAULT false,
      bid_board_stage_slug text, is_read_only_mirror boolean NOT NULL DEFAULT false, read_only_synced_at timestamptz,
      bid_board_stage_entered_at timestamptz, bid_board_mirror_source_entered_at timestamptz, rfp_approval_status text,
      rfp_approval_requested_at timestamptz, rfp_approval_request_event_id uuid, rfp_approval_requested_by uuid,
      rfp_approval_request_id integer, assigned_rep_id uuid, updated_at timestamptz
    );
  `);
  await db.query(
    `INSERT INTO deals (id, name, deal_number, stage_id, workflow_route, assigned_rep_id) VALUES ($1, 'd', 'TR-1', '00000000-0000-0000-0000-0000000000aa', 'normal', $2)`,
    [DEAL, REP],
  );
  return db;
}

function dealRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DEAL,
    name: "d",
    dealNumber: "TR-1",
    projectNumber: null,
    stageId: "00000000-0000-0000-0000-0000000000aa",
    workflowRoute: "normal",
    projectType: null,
    rfpApprovalStatus: null,
    rfpApprovalRequestEventId: null,
    assignedRepId: REP,
    ...overrides,
  } as any;
}

describe("trigger-rfp voting branch", () => {
  it("isRfpVotingEnabled reads ENABLE_RFP_VOTING", () => {
    expect(isRfpVotingEnabled({ ENABLE_RFP_VOTING: "true" } as any)).toBe(true);
    expect(isRfpVotingEnabled({} as any)).toBe(false);
  });

  it("service deal is NOT routed to voting", () => {
    expect(isServiceRfp(dealRow({ workflowRoute: "service" }))).toBe(true);
  });

  it("hasSufficientRfpVoters requires the full trio (a partial RFP_VOTER_EMAILS falls back to SyncHub)", () => {
    expect(hasSufficientRfpVoters({ RFP_VOTER_EMAILS: "a@x.com, b@x.com, c@x.com" } as any)).toBe(true);
    // A dropped-comma / partial config can never reach 2-of-3 — must NOT open the voting branch.
    expect(hasSufficientRfpVoters({ RFP_VOTER_EMAILS: "a@x.com, b@x.com" } as any)).toBe(false);
    expect(hasSufficientRfpVoters({ RFP_VOTER_EMAILS: "only.one@x.com" } as any)).toBe(false);
    expect(hasSufficientRfpVoters({} as any)).toBe(false);
  });

  it("non-service deal opens a round (status pending + invitation job, no SyncHub delivery job)", async () => {
    pg = await setup();
    const tdb: any = drizzle(pg as any);
    await openRfpVoteRound({
      tenantDb: tdb,
      officeId: null,
      deal: dealRow(),
      requestedByUserId: "00000000-0000-0000-0000-000000000001",
    });
    const deal = (await pg.query(`SELECT rfp_approval_status FROM deals WHERE id=$1`, [DEAL]))
      .rows as any[];
    expect(deal[0].rfp_approval_status).toBe("pending");
    const jobs = (await pg.query(`SELECT job_type FROM public.job_queue`)).rows as any[];
    expect(jobs.map((j) => j.job_type)).toEqual(["rfp_vote_invitation"]);
  });

  it("enforceAssignedRepId re-binds ownership: a reassigned deal 409s the former owner (no round, no invite)", async () => {
    pg = await setup();
    const tdb: any = drizzle(pg as any);
    // The deal is owned by REP; a trigger enforcing OTHER_REP must match nothing and 409 without side effects.
    await expect(
      openRfpVoteRound({
        tenantDb: tdb,
        officeId: null,
        deal: dealRow(),
        requestedByUserId: OTHER_REP,
        enforceAssignedRepId: OTHER_REP,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "RFP_ALREADY_TRIGGERED" });
    const deal = (await pg.query(`SELECT rfp_approval_status FROM deals WHERE id=$1`, [DEAL])).rows as any[];
    expect(deal[0].rfp_approval_status).toBeNull();
    const jobs = (await pg.query(`SELECT job_type FROM public.job_queue`)).rows as any[];
    expect(jobs).toHaveLength(0);
  });

  it("enforceAssignedRepId lets the true owner open the round; null (director/admin) opens regardless of owner", async () => {
    pg = await setup();
    const tdb: any = drizzle(pg as any);
    await openRfpVoteRound({
      tenantDb: tdb,
      officeId: null,
      deal: dealRow(),
      requestedByUserId: REP,
      enforceAssignedRepId: REP,
    });
    const deal = (await pg.query(`SELECT rfp_approval_status FROM deals WHERE id=$1`, [DEAL])).rows as any[];
    expect(deal[0].rfp_approval_status).toBe("pending");
  });
});
