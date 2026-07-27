import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const holder = vi.hoisted(() => ({ pg: null as any }));

async function pgQuery(text: string, params?: any[]) {
  const r = await holder.pg.query(text, params ?? []);
  return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
}

vi.mock("../../../src/db.js", () => ({
  pool: {
    query: (text: string, params?: any[]) => pgQuery(text, params),
    connect: async () => ({ query: (t: string, p?: any[]) => pgQuery(t, p), release: () => {} }),
  },
  releasePooledClient: () => {},
  isBrokenConnectionError: () => false,
}));
const auditMocks = vi.hoisted(() => ({ logActivityWithPgClient: vi.fn(async () => {}) }));
vi.mock("../../../src/modules/audit/pg-activity-logger.js", () => ({ logActivityWithPgClient: auditMocks.logActivityWithPgClient }));
vi.mock("../../../src/modules/audit/audit-logger.js", () => ({ buildAuditActorFromSystem: () => ({}) }));
vi.mock("../../../src/modules/audit/system-processes.js", () => ({ INTERNAL_RFP_RECEIVER: "internal_rfp_receiver" }));

const SECRET = "shared-secret";
const DEAL = "00000000-0000-0000-0000-0000000000d1";
const REP = "00000000-0000-0000-0000-000000000001";
const OPP = "00000000-0000-0000-0000-0000000000a1";
const EST = "00000000-0000-0000-0000-0000000000a2";

function sign(body: string) {
  return `sha256=${crypto.createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

async function seed() {
  const db = new PGlite();
  holder.pg = db;
  await db.exec(`
    CREATE SCHEMA office_test;
    CREATE TABLE public.pipeline_stage_config (id uuid PRIMARY KEY, slug text NOT NULL, display_order integer, is_terminal boolean NOT NULL DEFAULT false);
    INSERT INTO public.pipeline_stage_config (id, slug, display_order, is_terminal) VALUES ('${OPP}', 'opportunity', 3, false), ('${EST}', 'estimating', 5, false);
    CREATE TABLE office_test.deals (
      id uuid PRIMARY KEY, name text, deal_number text, project_number text, project_type text, bid_estimate numeric,
      estimator text, description text, bid_due_date timestamptz, property_address text, property_city text, property_state text,
      property_zip text, property_country text, stage_id uuid, company_id uuid, primary_contact_id uuid, procore_bid_id bigint,
      procore_company_id text, is_bid_board_owned boolean NOT NULL DEFAULT false, rfp_approval_status text, rfp_declined_reason text,
      rfp_declined_at timestamptz, rfp_override_state text, rfp_override_error text, rfp_override_decision text,
      rfp_override_reviewed_at timestamptz, rfp_bidboard_attempt_at timestamptz, rfp_last_attempt_error text, bid_board_linked_at timestamptz, assigned_rep_id uuid, rfp_approval_requested_by uuid,
      rfp_approval_request_id integer, rfp_approval_requested_at timestamptz, rfp_approval_request_event_id uuid, workflow_route text NOT NULL DEFAULT 'normal', stage_entered_at timestamptz,
      on_hold boolean NOT NULL DEFAULT false, on_hold_started_at timestamptz, on_hold_accumulated_seconds bigint DEFAULT 0,
      on_hold_accumulated_seconds_at_stage_entry bigint DEFAULT 0, is_active boolean NOT NULL DEFAULT true,
      bid_board_detached_at timestamptz, bid_board_detached_by uuid, bid_board_detach_reason text,
      bid_board_detached_was_linked boolean, synchub_bid_board_id text, updated_at timestamptz
    );
    CREATE TABLE office_test.deal_stage_history (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deal_id uuid, from_stage_id uuid, to_stage_id uuid, changed_by uuid,
      is_backward_move boolean, is_director_override boolean, override_reason text, duration_in_previous_stage interval,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  // Voting-path deal: pending round, NO rfp_approval_request_id.
  await db.query(
    `INSERT INTO office_test.deals (id, name, deal_number, stage_id, workflow_route, rfp_approval_status, rfp_approval_request_id, assigned_rep_id, rfp_approval_requested_by, stage_entered_at)
     VALUES ($1, 'jasonn ranches', 'TR-1001', $2, 'normal', 'pending', NULL, $3, $3, now())`,
    [DEAL, OPP, REP],
  );
  return db;
}

async function buildApp() {
  const { internalRfpRoutes } = await import("../../../src/modules/internal-rfp/routes.js");
  const app = express();
  app.use(internalRfpRoutes);
  return app;
}

describe("POST /bid-board-created (voting path)", () => {
  beforeEach(() => { process.env.SYNCHUB_SHARED_SECRET = SECRET; });
  afterEach(async () => { await holder.pg?.close(); holder.pg = null; vi.restoreAllMocks(); });

  it("advances a voting deal (no rfp_approval_request_id) on a 'created' callback with no rfpApprovalRequestId", async () => {
    await seed();
    const app = await buildApp();
    const raw = JSON.stringify({
      status: "created",
      sourceDealId: DEAL,
      bidboardProjectId: "88123",
      procoreCompanyId: "42",
      createdAt: new Date().toISOString(),
    });
    const res = await request(app).post("/bid-board-created").set("content-type", "application/json").set("x-rfp-request-signature", sign(raw)).send(raw);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const rows = (await holder.pg.query(`SELECT rfp_approval_status, is_bid_board_owned, procore_bid_id, stage_id FROM office_test.deals WHERE id=$1`, [DEAL])).rows as any[];
    expect(rows[0].rfp_approval_status).toBe("approved");
    expect(rows[0].is_bid_board_owned).toBe(true);
    expect(String(rows[0].procore_bid_id)).toBe("88123");
    expect(rows[0].stage_id).toBe(EST);
  });

  // Re-attachment after "Move back to Opportunity" (migration 0200). Detaching is deliberately sticky —
  // it is the ONLY thing stopping the Bid Board export from dragging the deal forward again — so the
  // marker must clear at exactly one moment: when a genuinely NEW Bid Board project is created for the
  // deal after it was re-submitted. That is this callback.
  it("clears the Bid Board detach marker when a NEW project is created for a re-submitted deal", async () => {
    await seed();
    // Simulate the post-move-back state: detached, then re-triggered (a fresh round reopened the RFP).
    await holder.pg.query(
      `UPDATE office_test.deals
          SET bid_board_detached_at = now() - interval '2 days',
              bid_board_detached_by = $2,
              bid_board_detach_reason = 'Scope was not ready',
              bid_board_detached_was_linked = true,
              -- Recorded by the /opportunities skipped_detached path while the deal was detached; it
              -- names the OLD project, which this callback is about to replace.
              synchub_bid_board_id = 'bb-old-project'
        WHERE id = $1`,
      [DEAL, REP],
    );
    auditMocks.logActivityWithPgClient.mockClear();
    const app = await buildApp();
    const raw = JSON.stringify({
      status: "created",
      sourceDealId: DEAL,
      bidboardProjectId: "88999",
      procoreCompanyId: "42",
      createdAt: new Date().toISOString(),
    });
    const res = await request(app).post("/bid-board-created").set("content-type", "application/json").set("x-rfp-request-signature", sign(raw)).send(raw);
    expect(res.status).toBe(200);

    const rows = (await holder.pg.query(
      `SELECT bid_board_detached_at, bid_board_detached_by, bid_board_detach_reason,
              bid_board_detached_was_linked, synchub_bid_board_id, is_bid_board_owned, procore_bid_id
         FROM office_test.deals WHERE id=$1`, [DEAL])).rows as any[];
    expect(rows[0].bid_board_detached_at).toBeNull();
    expect(rows[0].bid_board_detached_by).toBeNull();
    expect(rows[0].bid_board_detach_reason).toBeNull();
    // The persisted linkage answer is part of the detach marker set, so re-attachment clears it too —
    // otherwise a re-linked deal would keep claiming it had been severed from a project.
    expect(rows[0].bid_board_detached_was_linked).toBeNull();
    expect(rows[0].is_bid_board_owned).toBe(true);
    // The OLD project's stable identity is RETIRED. procore_bid_id now points at the new project, so
    // leaving the old bid_board_id behind makes /opportunities 409 forever on the mismatch
    // ("conflicts with the existing Procore Bid mapping") — the new project could never sync. Cleared,
    // the new project's first push finds the deal through the Procore fallback and backfills its own id.
    expect(rows[0].synchub_bid_board_id).toBeNull();

    // The re-attachment is AUDITED. The detach wrote an audit row; without its reversal here the trail
    // shows a deal severed from Bid Board sync that never came back — on the normal re-submission path.
    // The LINKAGE audit specifically — this callback also writes a separate stage-change audit row.
    const auditCall = auditMocks.logActivityWithPgClient.mock.calls
      .map((call) => call[0] as { fieldChanges?: Record<string, { from: unknown; to: unknown }> })
      .find((call) => call?.fieldChanges?.procoreBidId != null);
    expect(auditCall?.fieldChanges?.bidBoardDetachedAt?.to).toBeNull();
    expect(auditCall?.fieldChanges?.bidBoardDetachedAt?.from).not.toBeNull();
    expect(auditCall?.fieldChanges?.bidBoardDetachReason?.from).toBe("Scope was not ready");
    expect(auditCall?.fieldChanges?.synchubBidBoardId).toEqual({ from: "bb-old-project", to: null });
    expect(String(rows[0].procore_bid_id)).toBe("88999");
  });

  it("does NOT re-attach a detached deal whose RFP cycle was cleared (a stale 'created' cannot resurrect it)", async () => {
    await seed();
    // Exactly what returnDealToOpportunity leaves behind: detached AND rfp_approval_status NULL. A late
    // 'created' from the PRIOR round must not re-approve + re-own it — the existing resurrection guard
    // (AND rfp_approval_status IS NOT NULL) is what makes the detach survive.
    await holder.pg.query(
      `UPDATE office_test.deals
          SET bid_board_detached_at = now(), rfp_approval_status = NULL, rfp_approval_requested_at = NULL
        WHERE id = $1`,
      [DEAL],
    );
    const app = await buildApp();
    const raw = JSON.stringify({
      status: "created",
      sourceDealId: DEAL,
      bidboardProjectId: "88777",
      procoreCompanyId: "42",
      createdAt: new Date().toISOString(),
    });
    await request(app).post("/bid-board-created").set("content-type", "application/json").set("x-rfp-request-signature", sign(raw)).send(raw);

    const rows = (await holder.pg.query(
      `SELECT bid_board_detached_at, is_bid_board_owned, rfp_approval_status, procore_bid_id
         FROM office_test.deals WHERE id=$1`, [DEAL])).rows as any[];
    expect(rows[0].bid_board_detached_at).not.toBeNull();
    expect(rows[0].is_bid_board_owned).toBe(false);
    expect(rows[0].rfp_approval_status).toBeNull();
    expect(rows[0].procore_bid_id).toBeNull();
  });

  it("surfaces a visible failed marker on a voting deal (no rfp_approval_request_id) when the 'failed' callback lands", async () => {
    await seed();
    const app = await buildApp();
    const raw = JSON.stringify({
      status: "failed",
      sourceDealId: DEAL,
      error: "Procore Bid Board form timed out",
    });
    const res = await request(app).post("/bid-board-created").set("content-type", "application/json").set("x-rfp-request-signature", sign(raw)).send(raw);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, status: "failed", dealId: DEAL, applied: true });

    // The GO create failed -> the deal must leave the "creating" limbo into the VISIBLE send_failed attention
    // state (the Pending-RFP surface renders it + offers Retry) while also stamping the override audit marker.
    const rows = (await holder.pg.query(`SELECT rfp_approval_status, rfp_override_state, rfp_override_error, is_bid_board_owned FROM office_test.deals WHERE id=$1`, [DEAL])).rows as any[];
    expect(rows[0].rfp_override_state).toBe("failed");
    expect(rows[0].rfp_override_error).toBe("Procore Bid Board form timed out");
    // surfaced + retryable (send_failed), and never links / approves the deal on failure
    expect(rows[0].rfp_approval_status).toBe("send_failed");
    expect(rows[0].is_bid_board_owned).toBe(false);
  });

  it("is idempotent: a duplicate 'failed' callback re-reports applied:false without changing state", async () => {
    await seed();
    const app = await buildApp();
    const raw = JSON.stringify({ status: "failed", sourceDealId: DEAL, error: "boom" });
    const first = await request(app).post("/bid-board-created").set("content-type", "application/json").set("x-rfp-request-signature", sign(raw)).send(raw);
    const second = await request(app).post("/bid-board-created").set("content-type", "application/json").set("x-rfp-request-signature", sign(raw)).send(raw);
    expect(first.body.applied).toBe(true);
    expect(second.body.applied).toBe(false);
    const rows = (await holder.pg.query(`SELECT rfp_approval_status, rfp_override_state, rfp_override_error FROM office_test.deals WHERE id=$1`, [DEAL])).rows as any[];
    expect(rows[0].rfp_approval_status).toBe("send_failed");
    expect(rows[0].rfp_override_state).toBe("failed");
    expect(rows[0].rfp_override_error).toBe("boom");
  });

  it("[BC1] cross-round: a STALE request-less 'failed' (createdAt older than the CURRENT round's rfp_approval_requested_at) does NOT mark the fresh round send_failed; a fresh one does", async () => {
    await seed();
    // A fresh round reopened at this time. Both per-attempt markers (attempt_at + reviewed_at) are NULL — this is
    // the first attempt of the new round — so ONLY the cross-round guard can reject an old round's late 'failed'.
    await holder.pg.query(`UPDATE office_test.deals SET rfp_approval_requested_at = $2 WHERE id = $1`, [DEAL, "2026-07-03T00:00:00.000Z"]);
    const app = await buildApp();
    // A late 'failed' from the PRIOR round (createdAt before this round opened) must be a no-op.
    const staleRaw = JSON.stringify({ status: "failed", sourceDealId: DEAL, error: "old round failure", createdAt: "2026-06-01T00:00:00.000Z" });
    const stale = await request(app).post("/bid-board-created").set("content-type", "application/json").set("x-rfp-request-signature", sign(staleRaw)).send(staleRaw);
    expect(stale.status).toBe(200);
    expect(stale.body.applied).toBe(false);
    let rows = (await holder.pg.query(`SELECT rfp_approval_status, rfp_override_state FROM office_test.deals WHERE id=$1`, [DEAL])).rows as any[];
    expect(rows[0].rfp_approval_status).toBe("pending"); // fresh round untouched
    expect(rows[0].rfp_override_state).toBeNull();
    // A 'failed' from THIS round (createdAt at/after it opened) surfaces the visible send_failed marker.
    const freshRaw = JSON.stringify({ status: "failed", sourceDealId: DEAL, error: "this round failed", createdAt: "2026-07-03T01:00:00.000Z" });
    const fresh = await request(app).post("/bid-board-created").set("content-type", "application/json").set("x-rfp-request-signature", sign(freshRaw)).send(freshRaw);
    expect(fresh.body.applied).toBe(true);
    rows = (await holder.pg.query(`SELECT rfp_approval_status, rfp_override_state FROM office_test.deals WHERE id=$1`, [DEAL])).rows as any[];
    expect(rows[0].rfp_approval_status).toBe("send_failed");
    expect(rows[0].rfp_override_state).toBe("failed");
  });

  it("[finding] 422s a timestamp-less request-less 'failed' on an OPEN pending round (so SyncHub resends), applying nothing", async () => {
    await seed();
    // A live round is open (requested_at set); attempt_at + reviewed_at are NULL (first create).
    await holder.pg.query(`UPDATE office_test.deals SET rfp_approval_requested_at = $2 WHERE id = $1`, [DEAL, "2026-07-03T00:00:00.000Z"]);
    const app = await buildApp();
    const raw = JSON.stringify({ status: "failed", sourceDealId: DEAL, error: "no timestamp here" }); // NO createdAt
    const res = await request(app).post("/bid-board-created").set("content-type", "application/json").set("x-rfp-request-signature", sign(raw)).send(raw);
    expect(res.status).toBe(422); // resend a well-formed one rather than silently no-op at 200
    const rows = (await holder.pg.query(`SELECT rfp_approval_status, rfp_override_state FROM office_test.deals WHERE id=$1`, [DEAL])).rows as any[];
    expect(rows[0].rfp_approval_status).toBe("pending"); // untouched — NOT flipped to send_failed
    expect(rows[0].rfp_override_state).toBeNull();
  });

  it("[BC3] 422s a FIRST request-less 'created' that is missing createdAt (so SyncHub retries), then links a well-formed one", async () => {
    await seed();
    // A live round is open (requested_at set); attempt_at + reviewed_at are NULL (first create).
    await holder.pg.query(`UPDATE office_test.deals SET rfp_approval_requested_at = $2 WHERE id = $1`, [DEAL, "2026-07-03T00:00:00.000Z"]);
    const app = await buildApp();
    // Missing createdAt: the cross-round guard on the linkage would no-op it at 200, so 422 instead → SyncHub retries.
    const badRaw = JSON.stringify({ status: "created", sourceDealId: DEAL, bidboardProjectId: "88123", procoreCompanyId: "42" });
    const bad = await request(app).post("/bid-board-created").set("content-type", "application/json").set("x-rfp-request-signature", sign(badRaw)).send(badRaw);
    expect(bad.status).toBe(422);
    let rows = (await holder.pg.query(`SELECT rfp_approval_status, is_bid_board_owned FROM office_test.deals WHERE id=$1`, [DEAL])).rows as any[];
    expect(rows[0].rfp_approval_status).toBe("pending"); // NOT approved/linked
    expect(rows[0].is_bid_board_owned).toBe(false);
    // A well-formed 'created' (createdAt at/after the round opened) still links + approves — BC3 only blocks the
    // timestamp-less callback, never a valid one.
    const goodRaw = JSON.stringify({ status: "created", sourceDealId: DEAL, bidboardProjectId: "88123", procoreCompanyId: "42", createdAt: "2026-07-03T01:00:00.000Z" });
    const good = await request(app).post("/bid-board-created").set("content-type", "application/json").set("x-rfp-request-signature", sign(goodRaw)).send(goodRaw);
    expect(good.status).toBe(200);
    rows = (await holder.pg.query(`SELECT rfp_approval_status, is_bid_board_owned, procore_bid_id FROM office_test.deals WHERE id=$1`, [DEAL])).rows as any[];
    expect(rows[0].rfp_approval_status).toBe("approved");
    expect(rows[0].is_bid_board_owned).toBe(true);
    expect(String(rows[0].procore_bid_id)).toBe("88123");
  });

  it("[finding] ACKs a stale request-less callback (no id) after a legacy re-trigger, but 422s a current-round malformed one", async () => {
    await seed();
    // The deal was Returned to Opportunity + RE-TRIGGERED through the LEGACY path: it now carries a SyncHub request
    // id and a fresh round open time. An OLD request-less create-from-rfp callback (no id) is now arriving late.
    await holder.pg.query(
      `UPDATE office_test.deals SET rfp_approval_request_id = 555, rfp_approval_requested_at = $2 WHERE id = $1`,
      [DEAL, "2026-07-03T12:00:00.000Z"],
    );
    const app = await buildApp();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Stale request-less callback: createdAt BEFORE the current (legacy) round opened -> ACK (stop retrying), NOT 422.
    const staleRaw = JSON.stringify({ status: "created", sourceDealId: DEAL, bidboardProjectId: "77001", procoreCompanyId: "42", createdAt: "2026-07-03T09:00:00.000Z" });
    const stale = await request(app).post("/bid-board-created").set("content-type", "application/json").set("x-rfp-request-signature", sign(staleRaw)).send(staleRaw);
    expect(stale.status).toBe(200);
    expect(stale.body).toMatchObject({ success: true, idempotent: true, reason: "stale_callback_ignored" });
    // A current-round malformed callback (createdAt AT/AFTER the round opened) is still 422 (retryable, resend id).
    const freshRaw = JSON.stringify({ status: "created", sourceDealId: DEAL, bidboardProjectId: "77002", procoreCompanyId: "42", createdAt: "2026-07-03T13:00:00.000Z" });
    const fresh = await request(app).post("/bid-board-created").set("content-type", "application/json").set("x-rfp-request-signature", sign(freshRaw)).send(freshRaw);
    expect(fresh.status).toBe(422);
    warnSpy.mockRestore();
  });

  it("[#1] stale-ignores a request-backed 'created' callback (numeric rfpApprovalRequestId) after the request id was cleared — never approves a canceled deal", async () => {
    await seed();
    // Simulate cancelPendingRfp on a legacy/service/override deal: Return to Opportunity clears the request id +
    // status to NULL, leaves it on the opportunity stage, not Bid-Board-owned.
    await holder.pg.query(
      `UPDATE office_test.deals SET rfp_approval_status = NULL, rfp_approval_request_id = NULL, stage_id = $2, is_bid_board_owned = false WHERE id = $1`,
      [DEAL, OPP],
    );
    const app = await buildApp();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // A late callback STILL carries the OLD numeric request id — must be reconciled as stale, not treated like a
    // request-less voting 'created' (which would approve + Bid-Board-own the canceled Opportunity deal).
    const raw = JSON.stringify({
      status: "created",
      sourceDealId: DEAL,
      rfpApprovalRequestId: 4242,
      bidboardProjectId: "88123",
      procoreCompanyId: "42",
      createdAt: new Date().toISOString(),
    });
    const res = await request(app).post("/bid-board-created").set("content-type", "application/json").set("x-rfp-request-signature", sign(raw)).send(raw);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, idempotent: true, reason: "stale_callback_ignored" });

    const rows = (await holder.pg.query(`SELECT rfp_approval_status, is_bid_board_owned, procore_bid_id, stage_id FROM office_test.deals WHERE id=$1`, [DEAL])).rows as any[];
    expect(rows[0].rfp_approval_status).toBeNull();
    expect(rows[0].is_bid_board_owned).toBe(false);
    expect(rows[0].procore_bid_id).toBeNull();
    expect(rows[0].stage_id).toBe(OPP);
    warnSpy.mockRestore();
  });

  it("[F1] does NOT resurrect a request-less deal returned to Opportunity: a late 'created' with no rfpApprovalRequestId is a no-op when status is NULL", async () => {
    await seed();
    // Voting create failed -> user Returned to Opportunity: cancelPendingRfp cleared rfp_approval_status to NULL
    // (+ all RFP fields), left it on the opportunity stage, not Bid-Board-owned.
    await holder.pg.query(
      `UPDATE office_test.deals
          SET rfp_approval_status = NULL, rfp_approval_request_id = NULL, rfp_override_state = NULL,
              rfp_override_reviewed_at = NULL, stage_id = $2, is_bid_board_owned = false
        WHERE id = $1`,
      [DEAL, OPP],
    );
    const app = await buildApp();
    // A DELAYED 'created' from the prior request-less create — no rfpApprovalRequestId (voting never mints one),
    // reviewed_at is NULL (so the override freshness clause would exempt it) and the value-distinct guard passes.
    // Only the new `rfp_approval_status IS NOT NULL` guard stops it from re-approving + Bid-Board-owning the deal.
    const raw = JSON.stringify({
      status: "created",
      sourceDealId: DEAL,
      bidboardProjectId: "88123",
      procoreCompanyId: "42",
      createdAt: new Date().toISOString(),
    });
    const res = await request(app).post("/bid-board-created").set("content-type", "application/json").set("x-rfp-request-signature", sign(raw)).send(raw);
    // Acknowledged as an idempotent no-op (nothing to link) — SyncHub stops retrying without any resurrection.
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const rows = (await holder.pg.query(`SELECT rfp_approval_status, is_bid_board_owned, procore_bid_id, stage_id FROM office_test.deals WHERE id=$1`, [DEAL])).rows as any[];
    expect(rows[0].rfp_approval_status).toBeNull();
    expect(rows[0].is_bid_board_owned).toBe(false);
    expect(rows[0].procore_bid_id).toBeNull();
    expect(rows[0].stage_id).toBe(OPP);
  });

  it("[H4] a 2/3-yes retry is protected on the 'created' path too: a STALE 'created' (createdAt < attempt_at) does NOT link the old project; a FRESH one links", async () => {
    await seed();
    const ATTEMPT_AT = "2026-07-02T00:00:00.000Z";
    // A Retry re-set the deal to 'pending' and stamped rfp_bidboard_attempt_at as the CURRENT attempt.
    await holder.pg.query(
      `UPDATE office_test.deals SET rfp_approval_status = 'pending', rfp_bidboard_attempt_at = $2 WHERE id = $1`,
      [DEAL, ATTEMPT_AT],
    );
    const app = await buildApp();

    // STALE 'created' from the PRIOR exhausted attempt (createdAt < attempt_at) must NOT link the old project.
    const staleRaw = JSON.stringify({ status: "created", sourceDealId: DEAL, bidboardProjectId: "77001", procoreCompanyId: "42", createdAt: "2026-06-01T00:00:00.000Z" });
    const stale = await request(app).post("/bid-board-created").set("content-type", "application/json").set("x-rfp-request-signature", sign(staleRaw)).send(staleRaw);
    expect(stale.status).toBe(200);
    let rows = (await holder.pg.query(`SELECT rfp_approval_status, is_bid_board_owned, procore_bid_id, stage_id FROM office_test.deals WHERE id=$1`, [DEAL])).rows as any[];
    expect(rows[0].rfp_approval_status).toBe("pending"); // still awaiting the fresh attempt
    expect(rows[0].is_bid_board_owned).toBe(false);
    expect(rows[0].procore_bid_id).toBeNull();
    expect(rows[0].stage_id).toBe(OPP);

    // FRESH 'created' (createdAt >= attempt_at) links + approves + clears the marker.
    const freshRaw = JSON.stringify({ status: "created", sourceDealId: DEAL, bidboardProjectId: "88123", procoreCompanyId: "42", createdAt: "2026-07-03T00:00:00.000Z" });
    const fresh = await request(app).post("/bid-board-created").set("content-type", "application/json").set("x-rfp-request-signature", sign(freshRaw)).send(freshRaw);
    expect(fresh.status).toBe(200);
    rows = (await holder.pg.query(`SELECT rfp_approval_status, is_bid_board_owned, procore_bid_id, rfp_bidboard_attempt_at, stage_id FROM office_test.deals WHERE id=$1`, [DEAL])).rows as any[];
    expect(rows[0].rfp_approval_status).toBe("approved");
    expect(rows[0].is_bid_board_owned).toBe(true);
    expect(String(rows[0].procore_bid_id)).toBe("88123");
    expect(rows[0].rfp_bidboard_attempt_at).toBeNull(); // cleared on link
    expect(rows[0].stage_id).toBe(EST);
  });

  it("[F4] a 2/3-yes retry is protected: a STALE 'failed' (createdAt < rfp_bidboard_attempt_at) is a no-op; a FRESH one flips to send_failed", async () => {
    await seed();
    const ATTEMPT_AT = "2026-07-02T00:00:00.000Z";
    // A Retry re-set the 2/3-yes deal to 'pending' and stamped rfp_bidboard_attempt_at as the CURRENT attempt
    // (reviewed_at stays NULL — this is the pending sub-case, not an override).
    await holder.pg.query(
      `UPDATE office_test.deals SET rfp_approval_status = 'pending', rfp_bidboard_attempt_at = $2 WHERE id = $1`,
      [DEAL, ATTEMPT_AT],
    );
    const app = await buildApp();

    // STALE 'failed' from the PRIOR attempt (createdAt < attempt_at) must NOT flip the fresh retry to send_failed.
    const staleRaw = JSON.stringify({ status: "failed", sourceDealId: DEAL, error: "old failure", createdAt: "2026-06-01T00:00:00.000Z" });
    const stale = await request(app).post("/bid-board-created").set("content-type", "application/json").set("x-rfp-request-signature", sign(staleRaw)).send(staleRaw);
    expect(stale.status).toBe(200);
    expect(stale.body.applied).toBe(false);
    let rows = (await holder.pg.query(`SELECT rfp_approval_status, rfp_override_state FROM office_test.deals WHERE id=$1`, [DEAL])).rows as any[];
    expect(rows[0].rfp_approval_status).toBe("pending");
    expect(rows[0].rfp_override_state).toBeNull();

    // FRESH 'failed' (createdAt >= attempt_at) surfaces the visible send_failed marker for THIS attempt.
    const freshRaw = JSON.stringify({ status: "failed", sourceDealId: DEAL, error: "this attempt failed", createdAt: "2026-07-03T00:00:00.000Z" });
    const fresh = await request(app).post("/bid-board-created").set("content-type", "application/json").set("x-rfp-request-signature", sign(freshRaw)).send(freshRaw);
    expect(fresh.status).toBe(200);
    expect(fresh.body.applied).toBe(true);
    rows = (await holder.pg.query(`SELECT rfp_approval_status, rfp_override_state, rfp_override_error FROM office_test.deals WHERE id=$1`, [DEAL])).rows as any[];
    expect(rows[0].rfp_approval_status).toBe("send_failed");
    expect(rows[0].rfp_override_state).toBe("failed");
    expect(rows[0].rfp_override_error).toBe("this attempt failed");
  });

  it("[#3] freshness: a STALE request-less 'failed' (createdAt older than the attempt's reviewed_at) is a no-op; a FRESH one flips to send_failed", async () => {
    await seed();
    const REVIEWED_AT = "2026-07-01T00:00:00.000Z";
    // A reviewer override-approve of a NO-GO'd voting deal is in flight: declined + 'approving' with a bumped
    // rfp_override_reviewed_at marking the CURRENT attempt.
    await holder.pg.query(
      `UPDATE office_test.deals
          SET rfp_approval_status = 'declined',
              rfp_override_state = 'approving',
              rfp_override_decision = 'override_approved',
              rfp_override_reviewed_at = $2
        WHERE id = $1`,
      [DEAL, REVIEWED_AT],
    );
    const app = await buildApp();

    // STALE failed from a PRIOR attempt (createdAt < reviewed_at) must NOT clobber the fresh retry.
    const staleRaw = JSON.stringify({ status: "failed", sourceDealId: DEAL, error: "old failure", createdAt: "2026-06-01T00:00:00.000Z" });
    const stale = await request(app).post("/bid-board-created").set("content-type", "application/json").set("x-rfp-request-signature", sign(staleRaw)).send(staleRaw);
    expect(stale.status).toBe(200);
    expect(stale.body.applied).toBe(false);
    let rows = (await holder.pg.query(`SELECT rfp_approval_status, rfp_override_state, rfp_override_error FROM office_test.deals WHERE id=$1`, [DEAL])).rows as any[];
    expect(rows[0].rfp_approval_status).toBe("declined");
    expect(rows[0].rfp_override_state).toBe("approving");
    expect(rows[0].rfp_override_error).toBeNull();

    // FRESH failed (createdAt >= reviewed_at) stamps rfp_override_state='failed' but KEEPS status 'declined'
    // (finding G4) so the /rfp-review buttons (requestOverrideApproval / reconfirmRfpDecline) stay usable.
    const freshRaw = JSON.stringify({ status: "failed", sourceDealId: DEAL, error: "new failure", createdAt: "2026-07-02T00:00:00.000Z" });
    const fresh = await request(app).post("/bid-board-created").set("content-type", "application/json").set("x-rfp-request-signature", sign(freshRaw)).send(freshRaw);
    expect(fresh.status).toBe(200);
    expect(fresh.body.applied).toBe(true);
    rows = (await holder.pg.query(`SELECT rfp_approval_status, rfp_override_state, rfp_override_error FROM office_test.deals WHERE id=$1`, [DEAL])).rows as any[];
    expect(rows[0].rfp_approval_status).toBe("declined"); // kept declined (NOT send_failed) — review buttons stay usable
    expect(rows[0].rfp_override_state).toBe("failed");
    expect(rows[0].rfp_override_error).toBe("new failure");
  });

  it("[G3] 422s an override-approve 'failed' callback that is missing createdAt (so SyncHub retries, not silently drops)", async () => {
    await seed();
    // Override-approve in flight: declined + 'approving' + reviewed_at set. Its freshness needs a real createdAt.
    await holder.pg.query(
      `UPDATE office_test.deals SET rfp_approval_status = 'declined', rfp_override_state = 'approving', rfp_override_reviewed_at = '2026-07-01T00:00:00.000Z' WHERE id = $1`,
      [DEAL],
    );
    const app = await buildApp();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // A 'failed' with NO createdAt would otherwise no-op (0 rows) + 200, so SyncHub would stop retrying while the
    // deal is stuck 'approving'. Must 422 instead.
    const raw = JSON.stringify({ status: "failed", sourceDealId: DEAL, error: "creation failed" });
    const res = await request(app).post("/bid-board-created").set("content-type", "application/json").set("x-rfp-request-signature", sign(raw)).send(raw);
    expect(res.status).toBe(422);
    // Deal is untouched — still awaiting a well-formed callback.
    const rows = (await holder.pg.query(`SELECT rfp_approval_status, rfp_override_state, rfp_override_error FROM office_test.deals WHERE id=$1`, [DEAL])).rows as any[];
    expect(rows[0].rfp_approval_status).toBe("declined");
    expect(rows[0].rfp_override_state).toBe("approving");
    expect(rows[0].rfp_override_error).toBeNull();
    warnSpy.mockRestore();
  });
});
