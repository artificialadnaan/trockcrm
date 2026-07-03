import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

/**
 * REAL-SQL (PGlite) proof for the RFP override-approval flow (CRM PR #2). It installs the ACTUAL migration-0148
 * decline-email trigger on a throwaway tenant schema whose deals table carries the 0151 + 0152 override columns,
 * then drives the SAME column writes the service + bid-board-created callback handler perform, locking:
 *
 *   - approve override (rfp_override_state='approving', status untouched)  -> NO decline email (trigger is
 *                                                                            AFTER UPDATE OF rfp_approval_status);
 *   - 'created' callback (declined -> approved, clears override state)      -> NO email (NEW != 'declined') AND
 *                                                                            idempotent on at-least-once re-delivery;
 *   - 'failed' callback (rfp_override_state='failed', declined-only)        -> NO email, idempotent, and a no-op
 *                                                                            after the deal is already approved;
 *   - re-confirm denial (status untouched)                                 -> NO email;
 *   - the actionable guard locks a second approve while 'approving'.
 *
 * Inverting any guard (firing the email on an override, or double-applying a duplicate callback) breaks these.
 */

const MIGRATION_SQL = readFileSync(
  new URL("../../../../migrations/0148_rfp_rejected_email.sql", import.meta.url),
  "utf8",
);

const FN = extractFunction(MIGRATION_SQL);

function extractFunction(sql: string): string {
  const match = sql.match(/CREATE OR REPLACE FUNCTION public\.enqueue_rfp_rejected_email[\s\S]*?\$\$;/);
  if (!match) throw new Error("could not extract enqueue_rfp_rejected_email function body");
  return match[0];
}

const SCHEMA = "office_test";
const DEAL = "00000000-0000-0000-0000-0000000000d1";
const REQUESTER = "00000000-0000-0000-0000-000000000099";
const REVIEWER = "00000000-0000-0000-0000-0000000000a1";
// The deal's pre-callback stage (RFP) and the target stage the 'created' callback advances it to (Estimating).
const STAGE_RFP = "00000000-0000-0000-0000-0000000000f1";
const STAGE_ESTIMATING = "00000000-0000-0000-0000-0000000000f2";
// A createdAt guaranteed to be >= any reviewed_at set by overrideApprove() — for created tests that aren't about
// freshness (they just need the callback to pass the freshness guard).
const FRESH = "2999-01-01T00:00:00.000Z";
// A fixed stage_entered_at for the stage-transition helper (the value is irrelevant to the freshness guard).
const STAGE_ENTERED_AT = "2026-06-04T00:00:00.000Z";

let pg: PGlite | null = null;

afterEach(async () => {
  await pg?.close();
  pg = null;
});

async function setup(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE public.job_queue (
      id bigserial PRIMARY KEY,
      job_type text NOT NULL,
      payload jsonb NOT NULL,
      office_id uuid,
      status text NOT NULL,
      run_after timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE SCHEMA ${SCHEMA};
    CREATE TABLE ${SCHEMA}.deals (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      deal_number text NOT NULL,
      rfp_approval_status text,
      rfp_approval_request_id integer,
      rfp_approval_request_event_id uuid,
      rfp_approval_requested_by uuid,
      rfp_declined_reason text,
      rfp_override_reviewed_at timestamptz,
      rfp_override_reviewed_by uuid,
      rfp_override_decision text,
      rfp_override_note text,
      rfp_override_state text,
      rfp_override_error text,
      procore_bid_id bigint,
      procore_company_id text,
      is_bid_board_owned boolean DEFAULT false,
      bid_board_linked_at timestamptz,
      stage_id uuid,
      stage_entered_at timestamptz,
      on_hold_started_at timestamptz,
      on_hold_accumulated_seconds bigint,
      on_hold_accumulated_seconds_at_stage_entry bigint,
      updated_at timestamptz
    );
  `);
  await db.exec(FN);
  await db.exec(`
    CREATE TRIGGER deals_rfp_rejected_email_trg
      AFTER UPDATE OF rfp_approval_status ON ${SCHEMA}.deals
      FOR EACH ROW EXECUTE FUNCTION public.enqueue_rfp_rejected_email();
  `);
  return db;
}

async function insertDeclinedDeal(db: PGlite, requestId: number | null = 55): Promise<void> {
  await db.query(
    `INSERT INTO ${SCHEMA}.deals
       (id, name, deal_number, rfp_approval_status, rfp_approval_request_id, rfp_declined_reason, rfp_approval_requested_by, stage_id)
     VALUES ($1, 'jasonn ranches', 'TR-1001', 'declined', $2, 'Margins too thin', $3, $4)`,
    [DEAL, requestId, REQUESTER, STAGE_RFP],
  );
}

/** requestOverrideApproval's guarded UPDATE. */
async function overrideApprove(db: PGlite, id: string): Promise<number> {
  const res = await db.query(
    `UPDATE ${SCHEMA}.deals
        SET rfp_override_state = 'approving',
            rfp_override_error = NULL,
            rfp_override_reviewed_at = now(),
            rfp_override_reviewed_by = $2,
            rfp_override_decision = 'override_approved',
            rfp_override_note = NULL,
            updated_at = now()
      WHERE id = $1
        AND rfp_approval_status = 'declined'
        AND (rfp_override_state IS NULL OR rfp_override_state = 'failed')
        AND (rfp_override_decision IS NULL OR rfp_override_decision <> 'denial_reconfirmed')`,
    [id, REVIEWER],
  );
  return res.affectedRows ?? 0;
}

/** bid-board-created 'created' linkage UPDATE (declined -> approved, clears override state; freshness-guarded). */
async function createdCallback(
  db: PGlite,
  id: string,
  projectId: string,
  companyId: string,
  createdAt: string | null = null,
): Promise<number> {
  const res = await db.query(
    `UPDATE ${SCHEMA}.deals
        SET procore_bid_id = $1::bigint,
            procore_company_id = $2,
            is_bid_board_owned = true,
            rfp_approval_status = 'approved',
            bid_board_linked_at = now(),
            rfp_override_state = NULL,
            rfp_override_error = NULL,
            updated_at = now()
      WHERE id = $3
        AND rfp_override_decision IS DISTINCT FROM 'denial_reconfirmed'
        AND (rfp_override_reviewed_at IS NULL OR ($4::timestamptz IS NOT NULL AND $4::timestamptz >= rfp_override_reviewed_at))
        AND (
          procore_bid_id IS DISTINCT FROM $1::bigint OR
          procore_company_id IS DISTINCT FROM $2 OR
          is_bid_board_owned IS DISTINCT FROM true OR
          rfp_approval_status IS DISTINCT FROM 'approved' OR
          bid_board_linked_at IS NULL OR
          rfp_override_state IS NOT NULL OR
          rfp_override_error IS NOT NULL
        )`,
    [projectId, companyId, id, createdAt],
  );
  return res.affectedRows ?? 0;
}

/**
 * bid-board-created 'created' stage-transition UPDATE (advance to estimating). It carries the SAME terminal-denial +
 * override-flow freshness guard as the linkage UPDATE, but runs as a SEPARATE statement INDEPENDENTLY of whether the
 * linkage row matched — so its $8 freshness guard is load-bearing on its own and must reject a stale / timestamp-less
 * retry callback (mirrors internal-rfp/routes.ts stage UPDATE).
 */
async function createdStageTransition(
  db: PGlite,
  id: string,
  toStageId: string,
  fromStageId: string,
  createdAt: string | null = null,
): Promise<number> {
  const res = await db.query(
    `UPDATE ${SCHEMA}.deals
        SET stage_id = $1::uuid,
            stage_entered_at = $2::timestamptz,
            on_hold_started_at = $3::timestamptz,
            on_hold_accumulated_seconds = $4::bigint,
            on_hold_accumulated_seconds_at_stage_entry = $5::bigint,
            updated_at = now()
      WHERE id = $6
        AND stage_id = $7::uuid
        AND rfp_override_decision IS DISTINCT FROM 'denial_reconfirmed'
        AND (rfp_override_reviewed_at IS NULL OR ($8::timestamptz IS NOT NULL AND $8::timestamptz >= rfp_override_reviewed_at))`,
    [toStageId, STAGE_ENTERED_AT, null, 0, 0, id, fromStageId, createdAt],
  );
  return res.affectedRows ?? 0;
}

async function stageOf(db: PGlite, id: string): Promise<string | null> {
  const res = await db.query<{ stage_id: string | null }>(
    `SELECT stage_id FROM ${SCHEMA}.deals WHERE id = $1`,
    [id],
  );
  return res.rows[0]?.stage_id ?? null;
}

/** bid-board-created 'failed' UPDATE (declined-only, value-distinct, reconfirm-safe, freshness-guarded). */
async function failedCallback(
  db: PGlite,
  id: string,
  requestId: number,
  error: string,
  createdAt: string | null = null,
): Promise<number> {
  const res = await db.query(
    `UPDATE ${SCHEMA}.deals
        SET rfp_override_state = 'failed',
            rfp_override_error = $1,
            updated_at = now()
      WHERE id = $2
        AND rfp_approval_status = 'declined'
        AND rfp_approval_request_id = $3
        AND rfp_override_decision IS DISTINCT FROM 'denial_reconfirmed'
        AND COALESCE($4::timestamptz, NOW()) >= rfp_override_reviewed_at
        AND (rfp_override_state IS DISTINCT FROM 'failed' OR rfp_override_error IS DISTINCT FROM $1)`,
    [error, id, requestId, createdAt],
  );
  return res.affectedRows ?? 0;
}

/** reconfirmRfpDecline's guarded UPDATE (allowApproving: reconfirm is permitted from 'approving' too). */
async function reconfirm(db: PGlite, id: string): Promise<number> {
  const res = await db.query(
    `UPDATE ${SCHEMA}.deals
        SET rfp_override_reviewed_at = now(),
            rfp_override_reviewed_by = $2,
            rfp_override_decision = 'denial_reconfirmed',
            rfp_override_note = NULL,
            rfp_override_state = NULL,
            rfp_override_error = NULL,
            updated_at = now()
      WHERE id = $1
        AND rfp_approval_status = 'declined'
        AND (rfp_override_state IS NULL OR rfp_override_state = 'failed' OR rfp_override_state = 'approving')
        AND (rfp_override_decision IS NULL OR rfp_override_decision <> 'denial_reconfirmed')`,
    [id, REVIEWER],
  );
  return res.affectedRows ?? 0;
}

async function emailJobCount(db: PGlite): Promise<number> {
  const res = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.job_queue WHERE job_type = 'rfp_rejected_email'`,
  );
  return res.rows[0]?.n ?? 0;
}

async function dealState(db: PGlite, id: string) {
  const res = await db.query<{ status: string; state: string | null; error: string | null; decision: string | null }>(
    `SELECT rfp_approval_status AS status, rfp_override_state AS state, rfp_override_error AS error,
            rfp_override_decision AS decision
       FROM ${SCHEMA}.deals WHERE id = $1`,
    [id],
  );
  return res.rows[0];
}

describe("RFP override-approval flow vs migration 0148 decline trigger (real SQL)", () => {
  it("approve parks the deal in 'approving' (status stays declined) and fires NO decline email", async () => {
    pg = await setup();
    await insertDeclinedDeal(pg);

    expect(await overrideApprove(pg, DEAL)).toBe(1);
    expect(await emailJobCount(pg)).toBe(0);
    const d = await dealState(pg, DEAL);
    expect(d.status).toBe("declined");
    expect(d.state).toBe("approving");
  });

  it("a 'created' callback flips declined->approved, clears the override state, fires NO email, and is idempotent", async () => {
    pg = await setup();
    await insertDeclinedDeal(pg);
    await overrideApprove(pg, DEAL); // state='approving'

    expect(await createdCallback(pg, DEAL, "654321", "9001", FRESH)).toBe(1);
    const d = await dealState(pg, DEAL);
    expect(d.status).toBe("approved");
    expect(d.state).toBeNull();
    expect(await emailJobCount(pg)).toBe(0);

    // at-least-once re-delivery of the same 'created' callback -> no rows changed (no double-link/advance)
    expect(await createdCallback(pg, DEAL, "654321", "9001", FRESH)).toBe(0);
    expect(await emailJobCount(pg)).toBe(0);
  });

  it("a 'failed' callback marks the override failed (declined stays), fires NO email, is idempotent, and a no-op after approval", async () => {
    pg = await setup();
    await insertDeclinedDeal(pg, 55);
    await overrideApprove(pg, DEAL);

    expect(await failedCallback(pg, DEAL, 55, "Procore form timed out")).toBe(1);
    let d = await dealState(pg, DEAL);
    expect(d.status).toBe("declined");
    expect(d.state).toBe("failed");
    expect(d.error).toBe("Procore form timed out");
    expect(await emailJobCount(pg)).toBe(0);

    // duplicate identical 'failed' delivery -> no-op
    expect(await failedCallback(pg, DEAL, 55, "Procore form timed out")).toBe(0);

    // a reviewer retries -> approve again, then 'created' lands -> approved
    expect(await overrideApprove(pg, DEAL)).toBe(1); // failed -> approving (retry allowed)
    expect(await createdCallback(pg, DEAL, "654321", "9001", FRESH)).toBe(1);
    expect((await dealState(pg, DEAL)).status).toBe("approved");

    // a STALE 'failed' arriving after approval is a no-op (declined-only guard) — never reverts an approved deal
    expect(await failedCallback(pg, DEAL, 55, "late failure")).toBe(0);
    expect((await dealState(pg, DEAL)).status).toBe("approved");
    expect(await emailJobCount(pg)).toBe(0);
  });

  it("a late 'failed' retry does NOT resurrect 'failed' on a deal the reviewers already re-confirmed", async () => {
    pg = await setup();
    await insertDeclinedDeal(pg, 55);
    await overrideApprove(pg, DEAL);
    expect(await failedCallback(pg, DEAL, 55, "first failure")).toBe(1); // state='failed'
    // the reviewers give up and uphold the denial -> terminal: decision='denial_reconfirmed', state cleared
    expect(await reconfirm(pg, DEAL)).toBe(1);

    // a stale at-least-once retry of the OLD failed callback (same request id) arrives hours later
    expect(await failedCallback(pg, DEAL, 55, "first failure")).toBe(0);
    const d = await dealState(pg, DEAL);
    expect(d.state).toBeNull(); // NOT resurrected to 'failed'
    expect(d.decision).toBe("denial_reconfirmed"); // terminal review outcome preserved
    expect(await emailJobCount(pg)).toBe(0);
  });

  it("the original (non-override) flow is unaffected: a 'created' on a deal with no override attempt still links/approves", async () => {
    pg = await setup();
    await insertDeclinedDeal(pg, 55); // rfp_override_reviewed_at IS NULL (no override attempt)
    // even with a null createdAt, the freshness guard escapes (reviewed_at IS NULL) so the project still links
    expect(await createdCallback(pg, DEAL, "654321", "9001", null)).toBe(1);
    expect((await dealState(pg, DEAL)).status).toBe("approved");
  });

  it("a stale 'created' from a prior attempt does NOT link/approve a fresh in-flight retry", async () => {
    pg = await setup();
    await insertDeclinedDeal(pg, 55);
    // a retry (attempt 2) is in flight, started at a known time
    await pg.query(
      `UPDATE ${SCHEMA}.deals SET rfp_override_state='approving', rfp_override_decision='override_approved', rfp_override_reviewed_at='2026-06-02T00:00:00Z' WHERE id=$1`,
      [DEAL],
    );
    // a stale 'created' from attempt 1 (older createdAt, the old attempt's project) arrives -> ignored
    expect(await createdCallback(pg, DEAL, "111111", "9001", "2026-06-01T00:00:00Z")).toBe(0);
    let d = await dealState(pg, DEAL);
    expect(d.status).toBe("declined");
    expect(d.state).toBe("approving"); // fresh retry state preserved, not linked to the stale project

    // the CURRENT attempt's 'created' (newer) links + approves
    expect(await createdCallback(pg, DEAL, "222222", "9001", "2026-06-02T00:00:10Z")).toBe(1);
    expect((await dealState(pg, DEAL)).status).toBe("approved");
  });

  it("a 'created' with a missing/unparseable createdAt during a retry-in-flight is NOT treated as fresh", async () => {
    pg = await setup();
    await insertDeclinedDeal(pg, 55);
    // a retry is in flight (override-approve recorded a reviewed_at)
    await pg.query(
      `UPDATE ${SCHEMA}.deals SET rfp_override_state='approving', rfp_override_decision='override_approved', rfp_override_reviewed_at='2026-06-02T00:00:00Z' WHERE id=$1`,
      [DEAL],
    );
    // a stale 'created' that carries NO parseable timestamp must NOT substitute NOW() and link the old project
    expect(await createdCallback(pg, DEAL, "111111", "9001", null)).toBe(0);
    const d = await dealState(pg, DEAL);
    expect(d.status).toBe("declined"); // not linked/approved by the timestamp-less stale callback
    expect(d.state).toBe("approving"); // the fresh in-flight retry state is preserved
  });

  it("the SEPARATE stage-transition UPDATE carries the same freshness guard: a stale / timestamp-less retry callback does NOT advance the stage", async () => {
    pg = await setup();
    await insertDeclinedDeal(pg, 55); // stage_id = STAGE_RFP
    // a retry (attempt 2) is in flight: override-approve recorded a reviewed_at
    await pg.query(
      `UPDATE ${SCHEMA}.deals SET rfp_override_state='approving', rfp_override_decision='override_approved', rfp_override_reviewed_at='2026-06-02T00:00:00Z' WHERE id=$1`,
      [DEAL],
    );

    // a stale 'created' from attempt 1 (older createdAt) must NOT advance the stage out from under the fresh retry
    expect(await createdStageTransition(pg, DEAL, STAGE_ESTIMATING, STAGE_RFP, "2026-06-01T00:00:00Z")).toBe(0);
    expect(await stageOf(pg, DEAL)).toBe(STAGE_RFP);

    // a 'created' with NO parseable createdAt must NOT substitute NOW() and advance the stage during the retry
    // (this is the Codex P2 — the stage UPDATE must require a real $8 just like the linkage UPDATE)
    expect(await createdStageTransition(pg, DEAL, STAGE_ESTIMATING, STAGE_RFP, null)).toBe(0);
    expect(await stageOf(pg, DEAL)).toBe(STAGE_RFP);

    // the CURRENT attempt's 'created' (fresh createdAt >= reviewed_at) DOES advance to estimating
    expect(await createdStageTransition(pg, DEAL, STAGE_ESTIMATING, STAGE_RFP, "2026-06-02T00:00:10Z")).toBe(1);
    expect(await stageOf(pg, DEAL)).toBe(STAGE_ESTIMATING);
  });

  it("the stage-transition UPDATE never advances a deal the reviewers terminally re-confirmed", async () => {
    pg = await setup();
    await insertDeclinedDeal(pg, 55);
    await overrideApprove(pg, DEAL);
    await failedCallback(pg, DEAL, 55, "failed once");
    expect(await reconfirm(pg, DEAL)).toBe(1); // terminal: decision='denial_reconfirmed'

    // a (delayed) 'created' stage move for the same request id must NOT advance the re-confirmed denial
    expect(await createdStageTransition(pg, DEAL, STAGE_ESTIMATING, STAGE_RFP, FRESH)).toBe(0);
    expect(await stageOf(pg, DEAL)).toBe(STAGE_RFP);
  });

  it("a 'created' callback does NOT approve a deal the reviewers have terminally re-confirmed", async () => {
    pg = await setup();
    await insertDeclinedDeal(pg, 55);
    await overrideApprove(pg, DEAL);
    await failedCallback(pg, DEAL, 55, "failed once");
    expect(await reconfirm(pg, DEAL)).toBe(1); // terminal: decision='denial_reconfirmed'

    // a (delayed) 'created' for the same request id must NOT override the re-confirmed denial
    expect(await createdCallback(pg, DEAL, "654321", "9001", FRESH)).toBe(0);
    const d = await dealState(pg, DEAL);
    expect(d.status).toBe("declined");
    expect(d.decision).toBe("denial_reconfirmed");
  });

  it("a stale 'failed' retry from a prior attempt does NOT clobber a fresh in-flight retry", async () => {
    pg = await setup();
    await insertDeclinedDeal(pg, 55);
    // attempt 1 started at a known earlier time, then failed
    await pg.query(
      `UPDATE ${SCHEMA}.deals SET rfp_override_state='approving', rfp_override_decision='override_approved', rfp_override_reviewed_at='2026-06-01T00:00:00Z' WHERE id=$1`,
      [DEAL],
    );
    expect(await failedCallback(pg, DEAL, 55, "attempt 1 failed", "2026-06-01T00:00:10Z")).toBe(1);
    expect((await dealState(pg, DEAL)).state).toBe("failed");

    // the reviewer RETRIES -> attempt 2 starts later and is in flight ('approving')
    await pg.query(
      `UPDATE ${SCHEMA}.deals SET rfp_override_state='approving', rfp_override_reviewed_at='2026-06-02T00:00:00Z' WHERE id=$1`,
      [DEAL],
    );

    // a stale duplicate of attempt 1's failed callback (older createdAt) arrives -> ignored (freshness guard)
    expect(await failedCallback(pg, DEAL, 55, "attempt 1 failed", "2026-06-01T00:00:10Z")).toBe(0);
    expect((await dealState(pg, DEAL)).state).toBe("approving"); // NOT clobbered

    // attempt 2's own failure (newer createdAt) DOES apply
    expect(await failedCallback(pg, DEAL, 55, "attempt 2 failed", "2026-06-02T00:00:10Z")).toBe(1);
    expect((await dealState(pg, DEAL)).state).toBe("failed");
  });

  it("the actionable guard locks a second approve while one is already in flight ('approving')", async () => {
    pg = await setup();
    await insertDeclinedDeal(pg);

    expect(await overrideApprove(pg, DEAL)).toBe(1);
    // already 'approving' -> a duplicate click is a no-op (no second SyncHub call upstream)
    expect(await overrideApprove(pg, DEAL)).toBe(0);
    expect(await emailJobCount(pg)).toBe(0);
  });

  it("re-confirm denial fires NO email and is the duplicate-safe escape from a stuck 'approving' deal", async () => {
    pg = await setup();
    await insertDeclinedDeal(pg);

    expect(await reconfirm(pg, DEAL)).toBe(1);
    expect(await emailJobCount(pg)).toBe(0);
    expect((await dealState(pg, DEAL)).status).toBe("declined");

    // an 'approving' deal whose callback never arrives (e.g. an unconfirmed POST timeout) is NOT locked: upholding
    // the denial is allowed (it creates no project, so it's duplicate-safe even mid-flight) and clears the state.
    await pg.query(`UPDATE ${SCHEMA}.deals SET rfp_approval_status='declined', rfp_override_decision=NULL, rfp_override_reviewed_at=NULL WHERE id=$1`, [DEAL]);
    expect(await overrideApprove(pg, DEAL)).toBe(1); // genuinely enters the in-flight state...
    expect((await dealState(pg, DEAL)).state).toBe("approving"); // ...so the next line really tests approving->reconfirm
    expect(await reconfirm(pg, DEAL)).toBe(1);
    const d = await dealState(pg, DEAL);
    expect(d.state).toBeNull(); // 'approving' cleared
    expect(d.decision).toBe("denial_reconfirmed"); // terminal denial recorded
    expect(d.status).toBe("declined");
    expect(await emailJobCount(pg)).toBe(0);

    // re-approve, by contrast, stays BLOCKED while 'approving' (a retry must not race a possibly-in-flight attempt)
    await pg.query(`UPDATE ${SCHEMA}.deals SET rfp_override_decision='override_approved', rfp_override_state='approving' WHERE id=$1`, [DEAL]);
    expect(await overrideApprove(pg, DEAL)).toBe(0);
  });
});
