import { afterEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  handleRfpVoteInvitation,
  buildRfpVoteInvitationEmail,
  runRfpVoteInvitationDeadLetterSweep,
} from "../../src/jobs/rfp-vote-invitation.js";

const ENV = {
  RFP_VOTER_EMAILS: "sidney@x.com,tim@x.com,james@x.com",
  NODE_ENV: "test",
  FRONTEND_URL: "https://trockcrm.com",
} as any;

describe("handleRfpVoteInvitation", () => {
  it("emails the three configured voters with a /rfp-vote/:dealId link", async () => {
    const sendEmail = vi.fn(async () => ({ success: true, messageId: "m1" }));
    await handleRfpVoteInvitation(
      { dealId: "deal-1", dealNumber: "TR-1001", dealName: "jasonn ranches", officeId: "office-9", roundEventId: "round-evt-1" },
      "office-9",
      { sendEmail, env: ENV, logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } },
    );
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [recipients, subject, html, opts] = sendEmail.mock.calls[0];
    expect(recipients).toEqual(["sidney@x.com", "tim@x.com", "james@x.com"]);
    expect(subject).toContain("TR-1001");
    expect(html).toContain("/rfp-vote/deal-1");
    expect(html).toContain("officeId=office-9");
    expect(opts.idempotencyKey).toBe("rfp-vote-invite-deal-1-round-evt-1");
  });

  it("prefers the server-snapshotted payload.recipients over the worker's own env (finding H5)", async () => {
    const sendEmail = vi.fn(async () => ({ success: true, messageId: "m1" }));
    await handleRfpVoteInvitation(
      // Worker env resolves a DIFFERENT (stale) set; the payload carries the authoritative server trio.
      { dealId: "deal-1", recipients: ["sidney@x.com", "tim@x.com", "james@x.com"] },
      "office-9",
      { sendEmail, env: { RFP_VOTER_EMAILS: "stale@x.com", NODE_ENV: "test" } as any, logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } },
    );
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toEqual(["sidney@x.com", "tim@x.com", "james@x.com"]);
  });

  it("throws (fails loudly) when RFP_VOTER_EMAILS is unset in prod", async () => {
    const sendEmail = vi.fn(async () => ({ success: true, messageId: "m1" }));
    await expect(
      handleRfpVoteInvitation(
        { dealId: "deal-1" },
        "office-9",
        { sendEmail, env: { NODE_ENV: "production" } as any, logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } },
      ),
    ).rejects.toThrow(/RFP_VOTER_EMAILS/);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("buildRfpVoteInvitationEmail links with the office param and the caption '2 of 3'", () => {
    const email = buildRfpVoteInvitationEmail({ dealId: "deal-1", dealName: "d", dealNumber: null, officeId: "office-9", frontendUrl: "https://trockcrm.com/" });
    expect(email.html).toContain("https://trockcrm.com/rfp-vote/deal-1?officeId=office-9");
    expect(email.text).toContain("Two of three");
  });
});

// ---- F7: dead invitation sweep (real SQL / PGlite) ----
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const OFFICE = U("0f1");
const DEAL_NOVOTES = U("d01"); // pending round, no votes -> surfaced as send_failed (recoverable)
const DEAL_ONEVOTE = U("d02"); // pending round, ONE vote (NOT decided) -> still surfaced (finding H6)
const DEAL_DECIDED = U("d03"); // pending round, 2 approvals (DECIDED) -> left alone
const R1 = U("e01");
const R2 = U("e02");
const R3 = U("e03");

describe("runRfpVoteInvitationDeadLetterSweep (real SQL)", () => {
  let pg: PGlite | null = null;
  afterEach(async () => { await pg?.close(); pg = null; });

  async function seed() {
    const db = new PGlite();
    pg = db;
    await db.exec(`
      CREATE TABLE public.offices (id uuid PRIMARY KEY, slug text NOT NULL);
      CREATE TABLE public.job_queue (
        id bigserial PRIMARY KEY, job_type text NOT NULL, payload jsonb NOT NULL, office_id uuid,
        status text NOT NULL, last_error text, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE SCHEMA office_test;
      CREATE TABLE office_test.deals (
        id uuid PRIMARY KEY, rfp_approval_status text, rfp_approval_request_id integer,
        rfp_approval_request_event_id uuid, rfp_last_attempt_error text, updated_at timestamptz
      );
      CREATE TABLE office_test.rfp_votes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deal_id uuid NOT NULL, round_event_id uuid NOT NULL,
        voter_email text NOT NULL, decision text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO public.offices (id, slug) VALUES ('${OFFICE}', 'test');
      INSERT INTO office_test.deals (id, rfp_approval_status, rfp_approval_request_id, rfp_approval_request_event_id) VALUES
        ('${DEAL_NOVOTES}', 'pending', NULL, '${R1}'),
        ('${DEAL_ONEVOTE}', 'pending', NULL, '${R2}'),
        ('${DEAL_DECIDED}', 'pending', NULL, '${R3}');
      -- DEAL_ONEVOTE has ONE cast vote (round NOT decided): the OTHER voters may never have been notified, so
      -- it must STILL be surfaced (finding H6). DEAL_DECIDED already reached 2-of-3 → left alone.
      INSERT INTO office_test.rfp_votes (deal_id, round_event_id, voter_email, decision) VALUES
        ('${DEAL_ONEVOTE}', '${R2}', 'sidney@x.com', 'approve'),
        ('${DEAL_DECIDED}', '${R3}', 'sidney@x.com', 'approve'),
        ('${DEAL_DECIDED}', '${R3}', 'tim@x.com', 'approve');
      -- Three dead invitation jobs (one per deal).
      INSERT INTO public.job_queue (job_type, payload, office_id, status, last_error) VALUES
        ('rfp_vote_invitation', '{"dealId":"${DEAL_NOVOTES}"}'::jsonb, '${OFFICE}', 'dead', 'RFP_VOTER_EMAILS is not configured'),
        ('rfp_vote_invitation', '{"dealId":"${DEAL_ONEVOTE}"}'::jsonb, '${OFFICE}', 'dead', 'provider down'),
        ('rfp_vote_invitation', '{"dealId":"${DEAL_DECIDED}"}'::jsonb, '${OFFICE}', 'dead', 'provider down');
    `);
    return db;
  }

  it("surfaces a not-yet-DECIDED stranded round (0 OR 1 vote) as send_failed, but leaves a decided round alone (H6)", async () => {
    const db = await seed();
    const client = { query: (sql: string, params?: unknown[]) => db.query(sql, params as never[]) as any };

    const handled = await runRfpVoteInvitationDeadLetterSweep({ db: client as any });
    expect(handled).toBe(3); // all three jobs processed (marked handled)

    const novotes = (await db.query(`SELECT rfp_approval_status, rfp_last_attempt_error FROM office_test.deals WHERE id=$1`, [DEAL_NOVOTES])).rows as any[];
    expect(novotes[0].rfp_approval_status).toBe("send_failed"); // recoverable / cancellable
    expect(novotes[0].rfp_last_attempt_error).toBe("RFP_VOTER_EMAILS is not configured");

    const onevote = (await db.query(`SELECT rfp_approval_status FROM office_test.deals WHERE id=$1`, [DEAL_ONEVOTE])).rows as any[];
    expect(onevote[0].rfp_approval_status).toBe("send_failed"); // NOT decided → still surfaced (H6)

    const decided = (await db.query(`SELECT rfp_approval_status, rfp_last_attempt_error FROM office_test.deals WHERE id=$1`, [DEAL_DECIDED])).rows as any[];
    expect(decided[0].rfp_approval_status).toBe("pending"); // decided round → left alone
    expect(decided[0].rfp_last_attempt_error).toBeNull();

    // All dead jobs are marked handled so they aren't reprocessed.
    const jobs = (await db.query(`SELECT payload->>'dealHandled' AS handled FROM public.job_queue ORDER BY id`)).rows as any[];
    expect(jobs.map((j) => j.handled)).toEqual(["true", "true", "true"]);
  });

  it("is idempotent: a second sweep finds the jobs already handled and mutates nothing", async () => {
    const db = await seed();
    const client = { query: (sql: string, params?: unknown[]) => db.query(sql, params as never[]) as any };
    await runRfpVoteInvitationDeadLetterSweep({ db: client as any });
    const second = await runRfpVoteInvitationDeadLetterSweep({ db: client as any });
    expect(second).toBe(0); // nothing left to handle
  });
});
