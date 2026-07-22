import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { runRfpBidBoardCreateStuckDealSweep } from "../../src/jobs/rfp-bidboard-create.js";

// ---- Deal-keyed watchdog sweep (real SQL / PGlite) ----
// This sweep re-examines STUCK deals DIRECTLY (independent of any job's dealHandled flag) and flips a
// genuinely-dead create to send_failed. It exists because the per-JOB dead-letter sweep marks a dead job
// dealHandled='true' UNCONDITIONALLY (even when its deal UPDATE matched 0 rows), so a deal whose flip was
// missed is otherwise orphaned forever (a real DFW-2-19826-ae deal is in exactly this state).
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const OFFICE = U("0f1");

// Deal ids for the eight scenarios below.
const DEAL_STUCK = U("d01"); // genuinely stuck: pending + request-less + unowned + dead job + no live + old
const DEAL_OWNED = U("d02"); // already a Bid Board project (is_bid_board_owned=true) -> never touch
const DEAL_LIVE = U("d03"); // has a LIVE (pending/processing) create job -> still retrying, don't flip
const DEAL_NODEAD = U("d04"); // NO dead create job (never enqueued / all still pending) -> nothing dead to surface
const DEAL_GRACE = U("d05"); // attempt_at very recent (inside the 10-min grace window) -> too fresh, skip
const DEAL_REQUESTED = U("d06"); // rfp_approval_request_id set (requested/estimator path, not voting) -> skip
const DEAL_FRESH_ROUND = U("d07"); // dead job is from an OLD round; attempt_at is NEWER than it -> stale, skip
const DEAL_OVERRIDE = U("d08"); // override-approve sub-case (declined + approving) -> flips, KEEPS declined
const DEAL_NOERR = U("d09"); // dead job has NULL last_error -> flips with the generic fallback error
const DEAL_RETRIGGERED = U("d10"); // F4: re-triggered round (attempt_at NULL, requested_at FRESH) + OLD-round dead job -> skip
const DEAL_OVERRIDE_RETRY = U("d11"); // F5: override retry (reviewed_at FRESH, attempt_at NULL) + prior-attempt dead job -> skip
const DEAL_FOREIGN = U("d12"); // F7: only dead job belongs to ANOTHER office -> skip (office-scoped lookup)
const DEAL_STALE_ERR = U("d13"); // current-attempt dead job has NULL last_error, a PRIOR-attempt dead job has a
                                 // non-null error -> flips with the GENERIC fallback (not the stale prior error)
const DEAL_STALE_LIVE = U("d14"); // current-attempt dead job + a STALE (prior-round) PENDING job -> the stale
                                  // live job must NOT block recovery; the deal still flips to send_failed
const OFFICE2 = U("0f2"); // a DIFFERENT office id (not provisioned as a schema) — for the cross-office job test

/**
 * Seed a fresh PGlite with public.offices + public.job_queue + one office_test.deals + the eight deals above.
 * Mirrors the rfp-vote-invitation dead-letter runtime harness (same job_queue shape) but adds the deals columns
 * the stuck-deal sweep reads/writes.
 */
async function seed(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE public.offices (id uuid PRIMARY KEY, slug text NOT NULL, is_active boolean NOT NULL DEFAULT true);
    CREATE TABLE public.job_queue (
      id bigserial PRIMARY KEY, job_type text NOT NULL, payload jsonb NOT NULL, office_id uuid,
      status text NOT NULL, last_error text, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE SCHEMA office_test;
    CREATE TABLE office_test.deals (
      id uuid PRIMARY KEY,
      is_bid_board_owned boolean NOT NULL DEFAULT false,
      rfp_approval_status text,
      rfp_approval_request_id integer,
      rfp_approval_requested_at timestamptz,
      rfp_override_state text,
      rfp_override_error text,
      rfp_override_decision text,
      rfp_override_reviewed_at timestamptz,
      rfp_bidboard_attempt_at timestamptz,
      rfp_last_attempt_error text,
      updated_at timestamptz
    );
    INSERT INTO public.offices (id, slug, is_active) VALUES ('${OFFICE}', 'test', true);

    -- All seven deals share the request-less, unowned, override_state!=failed baseline unless noted otherwise.
    INSERT INTO office_test.deals
      (id, is_bid_board_owned, rfp_approval_status, rfp_approval_request_id, rfp_approval_requested_at,
       rfp_override_state, rfp_override_error, rfp_override_decision, rfp_override_reviewed_at, rfp_bidboard_attempt_at)
    VALUES
      -- STUCK: attempt_at NULL (first attempt, predates the stamp) -> eligible via the dead-job EXISTS guard.
      ('${DEAL_STUCK}', false, 'pending', NULL, NOW() - INTERVAL '2 hours', NULL, NULL, NULL, NULL, NULL),
      -- OWNED: already a Bid Board project -> never touch.
      ('${DEAL_OWNED}', true, 'pending', NULL, NOW() - INTERVAL '2 hours', NULL, NULL, NULL, NULL, NULL),
      -- LIVE: still has a pending/processing create job retrying -> don't flip.
      ('${DEAL_LIVE}', false, 'pending', NULL, NOW() - INTERVAL '2 hours', NULL, NULL, NULL, NULL, NULL),
      -- NODEAD: no dead create job exists -> nothing dead to surface.
      ('${DEAL_NODEAD}', false, 'pending', NULL, NOW() - INTERVAL '2 hours', NULL, NULL, NULL, NULL, NULL),
      -- GRACE: attempt_at 1 min ago (inside the 10-min grace window) -> too fresh, skip.
      ('${DEAL_GRACE}', false, 'pending', NULL, NOW() - INTERVAL '2 hours', NULL, NULL, NULL, NULL, NOW() - INTERVAL '1 minute'),
      -- REQUESTED: request_id set -> requested/estimator path, not voting -> skip.
      ('${DEAL_REQUESTED}', false, 'pending', 42, NOW() - INTERVAL '2 hours', NULL, NULL, NULL, NULL, NULL),
      -- FRESH_ROUND: attempt_at is NEWER than the dead job (an OLD round's dead job) -> stale, skip.
      ('${DEAL_FRESH_ROUND}', false, 'pending', NULL, NOW() - INTERVAL '2 hours', NULL, NULL, NULL, NULL, NOW() - INTERVAL '30 minutes'),
      -- OVERRIDE: override-approve create-in-flight (declined + override_state 'approving') -> flips, but the
      -- status MUST STAY 'declined' (only override_state -> 'failed'), so /rfp-review buttons keep working.
      ('${DEAL_OVERRIDE}', false, 'declined', NULL, NOW() - INTERVAL '2 hours', 'approving', NULL, NULL, NULL, NULL),
      -- NOERR: stuck like DEAL_STUCK, but its dead job carries NO last_error -> the generic fallback is used.
      ('${DEAL_NOERR}', false, 'pending', NULL, NOW() - INTERVAL '2 hours', NULL, NULL, NULL, NULL, NULL),
      -- RETRIGGERED (F4): a failed round was Returned-to-Opportunity + re-triggered — attempt_at cleared to NULL,
      -- requested_at bumped to NOW (fresh round). The OLD round's dead job must NOT flip the fresh round.
      ('${DEAL_RETRIGGERED}', false, 'pending', NULL, NOW() - INTERVAL '5 minutes', NULL, NULL, NULL, NULL, NULL),
      -- OVERRIDE_RETRY (F5): an override-approve was retried — reviewed_at bumped to NOW, attempt_at still NULL.
      -- The prior attempt's dead job must NOT flip the fresh 'approving' state to failed.
      ('${DEAL_OVERRIDE_RETRY}', false, 'declined', NULL, NULL, 'approving', NULL, NULL, NOW() - INTERVAL '5 minutes', NULL),
      -- FOREIGN (F7): stuck baseline, but its only dead create job belongs to ANOTHER office -> office-scoped skip.
      ('${DEAL_FOREIGN}', false, 'pending', NULL, NOW() - INTERVAL '2 hours', NULL, NULL, NULL, NULL, NULL),
      -- STALE_ERR: genuinely stuck on the CURRENT attempt (attempt_at 30 min ago, past the grace window). Its
      -- current-attempt dead job carries NO last_error, but a PRIOR-attempt dead job (predating attempt_at) has a
      -- non-null error. The error subquery must apply the SAME per-attempt freshness guards as the eligibility
      -- EXISTS, so it ignores the stale prior error and falls back to the generic message.
      ('${DEAL_STALE_ERR}', false, 'pending', NULL, NOW() - INTERVAL '2 hours', NULL, NULL, NULL, NULL, NOW() - INTERVAL '30 minutes'),
      -- STALE_LIVE (finding): genuinely stuck on the CURRENT attempt (attempt_at 30 min ago, past grace). Its
      -- current-attempt dead job (created 20 min ago, AFTER attempt_at) matches the eligibility EXISTS. But a
      -- STALE PENDING create job from a PRIOR round (created 1h ago, BEFORE attempt_at) is still on the queue —
      -- its handler will reject it on the round recheck, so it can never advance this deal. The live-job NOT
      -- EXISTS must be scoped to the current attempt so this stale pending job does NOT block recovery.
      ('${DEAL_STALE_LIVE}', false, 'pending', NULL, NOW() - INTERVAL '2 hours', NULL, NULL, NULL, NULL, NOW() - INTERVAL '30 minutes');

    -- Dead / live create jobs. The stuck-deal sweep keys on payload->>'dealId'.
    INSERT INTO public.job_queue (job_type, payload, office_id, status, last_error, created_at) VALUES
      -- STUCK: a dead create job (created 1h ago).
      ('rfp_bidboard_create', '{"dealId":"${DEAL_STUCK}"}'::jsonb, '${OFFICE}', 'dead', 'rfp_bidboard_create failed with 502: edge timeout', NOW() - INTERVAL '1 hour'),
      -- OWNED: a dead create job too (proving the ownership guard is what excludes it, not a missing dead job).
      ('rfp_bidboard_create', '{"dealId":"${DEAL_OWNED}"}'::jsonb, '${OFFICE}', 'dead', 'boom', NOW() - INTERVAL '1 hour'),
      -- LIVE: a dead job AND a live (pending) retry -> the live one blocks the flip.
      ('rfp_bidboard_create', '{"dealId":"${DEAL_LIVE}"}'::jsonb, '${OFFICE}', 'dead', 'boom', NOW() - INTERVAL '1 hour'),
      ('rfp_bidboard_create', '{"dealId":"${DEAL_LIVE}"}'::jsonb, '${OFFICE}', 'pending', NULL, NOW() - INTERVAL '5 minutes'),
      -- NODEAD: only a live job, no dead one.
      ('rfp_bidboard_create', '{"dealId":"${DEAL_NODEAD}"}'::jsonb, '${OFFICE}', 'processing', NULL, NOW() - INTERVAL '5 minutes'),
      -- GRACE: a dead job (old), but the deal's attempt_at is inside the grace window.
      ('rfp_bidboard_create', '{"dealId":"${DEAL_GRACE}"}'::jsonb, '${OFFICE}', 'dead', 'boom', NOW() - INTERVAL '1 hour'),
      -- REQUESTED: a dead job (proving the request_id guard excludes it, not a missing dead job).
      ('rfp_bidboard_create', '{"dealId":"${DEAL_REQUESTED}"}'::jsonb, '${OFFICE}', 'dead', 'boom', NOW() - INTERVAL '1 hour'),
      -- FRESH_ROUND: a dead job from an OLD round (created 1h ago), BEFORE the deal's 30-min-old attempt_at stamp.
      ('rfp_bidboard_create', '{"dealId":"${DEAL_FRESH_ROUND}"}'::jsonb, '${OFFICE}', 'dead', 'old round boom', NOW() - INTERVAL '1 hour'),
      -- OVERRIDE: a dead create job for the override-approve deal.
      ('rfp_bidboard_create', '{"dealId":"${DEAL_OVERRIDE}"}'::jsonb, '${OFFICE}', 'dead', 'override create 500', NOW() - INTERVAL '1 hour'),
      -- NOERR: a dead create job with NO last_error.
      ('rfp_bidboard_create', '{"dealId":"${DEAL_NOERR}"}'::jsonb, '${OFFICE}', 'dead', NULL, NOW() - INTERVAL '1 hour'),
      -- RETRIGGERED: an OLD-round dead job (created 1h ago, BEFORE the fresh 5-min-old requested_at).
      ('rfp_bidboard_create', '{"dealId":"${DEAL_RETRIGGERED}"}'::jsonb, '${OFFICE}', 'dead', 'old round boom', NOW() - INTERVAL '1 hour'),
      -- OVERRIDE_RETRY: a prior-attempt dead job (1h ago, BEFORE the fresh 5-min-old reviewed_at).
      ('rfp_bidboard_create', '{"dealId":"${DEAL_OVERRIDE_RETRY}"}'::jsonb, '${OFFICE}', 'dead', 'old override attempt', NOW() - INTERVAL '1 hour'),
      -- FOREIGN: a dead job that belongs to ANOTHER office (office_id=OFFICE2) — the office-scoped EXISTS ignores it.
      ('rfp_bidboard_create', '{"dealId":"${DEAL_FOREIGN}"}'::jsonb, '${OFFICE2}', 'dead', 'foreign office boom', NOW() - INTERVAL '1 hour'),
      -- STALE_ERR: the CURRENT-attempt dead job (created AFTER the 30-min-old attempt_at) has NO last_error...
      ('rfp_bidboard_create', '{"dealId":"${DEAL_STALE_ERR}"}'::jsonb, '${OFFICE}', 'dead', NULL, NOW() - INTERVAL '20 minutes'),
      -- ...and a PRIOR-attempt dead job (created BEFORE attempt_at) carries a stale non-null error the sweep must ignore.
      ('rfp_bidboard_create', '{"dealId":"${DEAL_STALE_ERR}"}'::jsonb, '${OFFICE}', 'dead', 'STALE prior-attempt error', NOW() - INTERVAL '1 hour'),
      -- STALE_LIVE: a CURRENT-attempt dead job (created 20 min ago, AFTER the 30-min-old attempt_at)...
      ('rfp_bidboard_create', '{"dealId":"${DEAL_STALE_LIVE}"}'::jsonb, '${OFFICE}', 'dead', 'current attempt boom', NOW() - INTERVAL '20 minutes'),
      -- ...PLUS a STALE PENDING job from a PRIOR round (created 1h ago, BEFORE attempt_at) that must NOT block the flip.
      ('rfp_bidboard_create', '{"dealId":"${DEAL_STALE_LIVE}"}'::jsonb, '${OFFICE}', 'pending', NULL, NOW() - INTERVAL '1 hour');
  `);
  return db;
}

describe("runRfpBidBoardCreateStuckDealSweep (real SQL)", () => {
  let pg: PGlite | null = null;
  afterEach(async () => { await pg?.close(); pg = null; });

  async function run() {
    pg = await seed();
    const db = pg;
    const client = { query: (sql: string, params?: unknown[]) => db.query(sql, params as never[]) as any };
    const flipped = await runRfpBidBoardCreateStuckDealSweep({ db: client as any });
    return { db, flipped };
  }

  async function status(db: PGlite, id: string) {
    const rows = (await db.query(
      `SELECT rfp_approval_status, rfp_override_state, rfp_override_error, rfp_last_attempt_error
         FROM office_test.deals WHERE id = $1`,
      [id],
    )).rows as any[];
    return rows[0];
  }

  it("1. flips a genuinely-stuck deal to send_failed (override 'failed' + last_attempt_error from the dead job)", async () => {
    const { db, flipped } = await run();
    // The genuinely-stuck deals are: DEAL_STUCK, DEAL_OVERRIDE (declined+approving), DEAL_NOERR (no last_error),
    // DEAL_STALE_ERR (current-attempt dead job has no error, prior-attempt error ignored), DEAL_STALE_LIVE
    // (current-attempt dead job + a stale prior-round pending job that must not block the flip).
    expect(flipped).toBe(5);
    const s = await status(db, DEAL_STUCK);
    expect(s.rfp_approval_status).toBe("send_failed");
    expect(s.rfp_override_state).toBe("failed");
    // The surfaced error comes from the dead job's last_error, truncated to 2000 chars.
    expect(s.rfp_override_error).toBe("rfp_bidboard_create failed with 502: edge timeout");
    expect(s.rfp_last_attempt_error).toBe("rfp_bidboard_create failed with 502: edge timeout");
  });

  it("2. does NOT flip an already-owned deal (is_bid_board_owned=true)", async () => {
    const { db } = await run();
    const s = await status(db, DEAL_OWNED);
    expect(s.rfp_approval_status).toBe("pending");
    expect(s.rfp_override_state).toBeNull();
  });

  it("3. does NOT flip a deal with a LIVE (pending/processing) create job", async () => {
    const { db } = await run();
    const s = await status(db, DEAL_LIVE);
    expect(s.rfp_approval_status).toBe("pending");
    expect(s.rfp_override_state).toBeNull();
  });

  it("4. does NOT flip a deal with NO dead create job", async () => {
    const { db } = await run();
    const s = await status(db, DEAL_NODEAD);
    expect(s.rfp_approval_status).toBe("pending");
    expect(s.rfp_override_state).toBeNull();
  });

  it("5. does NOT flip a deal inside the grace window (attempt_at very recent)", async () => {
    const { db } = await run();
    const s = await status(db, DEAL_GRACE);
    expect(s.rfp_approval_status).toBe("pending");
    expect(s.rfp_override_state).toBeNull();
  });

  it("6. does NOT flip a deal with a request_id set (requested/estimator path, not voting)", async () => {
    const { db } = await run();
    const s = await status(db, DEAL_REQUESTED);
    expect(s.rfp_approval_status).toBe("pending");
    expect(s.rfp_override_state).toBeNull();
  });

  it("7. is idempotent: a second run flips nothing (returns 0)", async () => {
    pg = await seed();
    const db = pg;
    const client = { query: (sql: string, params?: unknown[]) => db.query(sql, params as never[]) as any };
    const first = await runRfpBidBoardCreateStuckDealSweep({ db: client as any });
    expect(first).toBe(5);
    const second = await runRfpBidBoardCreateStuckDealSweep({ db: client as any });
    expect(second).toBe(0); // already override_state='failed' -> the idempotency guard excludes them all
    // And the deal state is unchanged / still surfaced.
    const s = await status(db, DEAL_STUCK);
    expect(s.rfp_approval_status).toBe("send_failed");
    expect(s.rfp_override_state).toBe("failed");
  });

  it("8. does NOT flip based on an OLD-round dead job when attempt_at is newer than that job (freshness)", async () => {
    const { db } = await run();
    const s = await status(db, DEAL_FRESH_ROUND);
    expect(s.rfp_approval_status).toBe("pending");
    expect(s.rfp_override_state).toBeNull();
  });

  it("9. flips the override-approve sub-case (declined + approving) but KEEPS status 'declined'", async () => {
    const { db } = await run();
    const s = await status(db, DEAL_OVERRIDE);
    // Only override_state -> 'failed'; the status stays 'declined' so /rfp-review buttons keep working, and
    // rfp_last_attempt_error is NOT populated (that visible field is only for the send_failed sub-case).
    expect(s.rfp_approval_status).toBe("declined");
    expect(s.rfp_override_state).toBe("failed");
    expect(s.rfp_override_error).toBe("override create 500");
    expect(s.rfp_last_attempt_error).toBeNull();
  });

  it("10. flips with the generic fallback error when the dead job carries no last_error", async () => {
    const { db } = await run();
    const s = await status(db, DEAL_NOERR);
    expect(s.rfp_approval_status).toBe("send_failed");
    expect(s.rfp_override_state).toBe("failed");
    expect(s.rfp_override_error).toBe("Bid Board create failed (recovered by stuck-deal sweep)");
    expect(s.rfp_last_attempt_error).toBe("Bid Board create failed (recovered by stuck-deal sweep)");
  });

  it("11. does NOT flip a re-triggered fresh round from a PRIOR round's dead job (requested_at freshness)", async () => {
    // openRfpVoteRound clears rfp_bidboard_attempt_at to NULL on re-trigger but bumps rfp_approval_requested_at;
    // the old round's dead job (created BEFORE the fresh requested_at) must not flip the still-undecided round.
    const { db } = await run();
    const s = await status(db, DEAL_RETRIGGERED);
    expect(s.rfp_approval_status).toBe("pending");
    expect(s.rfp_override_state).toBeNull();
  });

  it("12. does NOT flip a retried override (approving) from a prior attempt's dead job (reviewed_at freshness)", async () => {
    // approveRfpOverride bumps rfp_override_reviewed_at but leaves attempt_at NULL; the prior attempt's dead job
    // must not flip the fresh 'approving' state back to failed (which would re-enable approval + risk a dup create).
    const { db } = await run();
    const s = await status(db, DEAL_OVERRIDE_RETRY);
    expect(s.rfp_approval_status).toBe("declined");
    expect(s.rfp_override_state).toBe("approving"); // unchanged — NOT flipped to 'failed'
  });

  it("13. does NOT flip from a dead job that belongs to ANOTHER office (job lookups scoped to office_id)", async () => {
    // public.job_queue is shared; a deal UUID is unique only within its tenant schema. A foreign office's dead
    // job (same UUID) must not surface a false failure on this office's deal.
    const { db } = await run();
    const s = await status(db, DEAL_FOREIGN);
    expect(s.rfp_approval_status).toBe("pending");
    expect(s.rfp_override_state).toBeNull();
  });

  it("14. surfaces the GENERIC fallback (not a stale PRIOR-attempt error) when the current-attempt dead job has no last_error", async () => {
    // finding: the eligibility EXISTS matches the CURRENT attempt's dead job (created after attempt_at), which has
    // last_error=NULL. Without the same freshness guards on the error subquery, `AND last_error IS NOT NULL` would
    // skip it and pick the older prior-attempt job's STALE error — marking the deal with an obsolete reason. The
    // guards make the subquery read only the current attempt, so it correctly falls back to the generic message.
    const { db } = await run();
    const s = await status(db, DEAL_STALE_ERR);
    expect(s.rfp_approval_status).toBe("send_failed");
    expect(s.rfp_override_state).toBe("failed");
    expect(s.rfp_override_error).toBe("Bid Board create failed (recovered by stuck-deal sweep)");
    expect(s.rfp_last_attempt_error).toBe("Bid Board create failed (recovered by stuck-deal sweep)");
    // Explicitly NOT the stale prior-attempt error.
    expect(s.rfp_override_error).not.toBe("STALE prior-attempt error");
  });

  it("15. flips despite a STALE prior-round PENDING job (live-job NOT EXISTS is scoped to the current attempt)", async () => {
    // finding: the live-job NOT EXISTS must carry the SAME per-attempt freshness guards as the dead-job EXISTS.
    // After a Return-to-Opportunity + re-trigger (or an override retry) an OLD create job from the prior round can
    // still be sitting 'pending' on queue backoff; its handler rejects it on the round recheck so it can never
    // advance this deal. An UNQUALIFIED NOT EXISTS would treat that stale pending job as a live retry and block
    // recovery of a deal whose CURRENT attempt genuinely died. Here the current-attempt dead job (20 min old,
    // after the 30-min attempt_at) makes the deal eligible, and the stale pending job (1h old, before attempt_at)
    // must NOT suppress the flip.
    const { db } = await run();
    const s = await status(db, DEAL_STALE_LIVE);
    expect(s.rfp_approval_status).toBe("send_failed");
    expect(s.rfp_override_state).toBe("failed");
    expect(s.rfp_override_error).toBe("current attempt boom");
    expect(s.rfp_last_attempt_error).toBe("current attempt boom");
  });
});
