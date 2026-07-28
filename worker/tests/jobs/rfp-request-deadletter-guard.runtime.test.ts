import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { runRfpRequestDeadLetterSweep } from "../../src/jobs/rfp-request-delivery.js";

// ---- Dead-letter sweep write guard (real SQL / PGlite) ----
//
// runRfpRequestDeadLetterSweep was the ONE writer of rfp_approval_status in this worker with no
// predicate at all: `SET rfp_approval_status = 'send_failed' … WHERE id = $2`. Its two siblings in the
// same file (the success and conflict write-backs) have carried a two-part status+round guard since
// round 7; this one was raised in rounds 6, 7 and 9 and each round guarded a different CALLER instead.
//
// The `dealHandled` opt-out that "Move back to Opportunity" stamps is real but incomplete: the move-back
// cancels only jobs in status ('pending','dead'), so a job already CLAIMED ('processing') when it ran is
// never stamped. When that job later exhausts its retries and lands 'dead', this sweep picks it up — and
// before the guard, wrote send_failed onto a deal whose cycle had been cleared. That repopulates
// rfp_approval_status, which re-locks the deal's scope, re-arms the callback's `IS NOT NULL`
// resurrection guard, and blocks re-triggering: the dead end the whole feature exists to remove.
//
// Real SQL rather than a string-mock assertion on purpose — a guard is only worth what the database
// actually does with it, and asserting the WHERE text would pass on a predicate that never matches.
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const OFFICE = U("0f1");

const ROUND_LIVE = U("a01"); // the round the dead job was built for
const ROUND_OTHER = U("a02"); // a DIFFERENT, later round

const DEAL_CLEARED = U("d01"); // moved back to Opportunity: rfp_approval_status IS NULL
const DEAL_AWAITING = U("d02"); // still awaiting THIS round -> the legitimate case, must still flip
const DEAL_NEW_ROUND = U("d03"); // moved back AND re-triggered: awaiting, but a DIFFERENT round
const DEAL_NO_ROUND = U("d04"); // legacy payload with no parseable round -> must FAIL OPEN and flip

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
      rfp_approval_status text,
      rfp_approval_request_event_id uuid,
      rfp_last_attempt_error text,
      updated_at timestamptz
    );
    INSERT INTO public.offices (id, slug, is_active) VALUES ('${OFFICE}', 'test', true);

    INSERT INTO office_test.deals (id, rfp_approval_status, rfp_approval_request_event_id) VALUES
      ('${DEAL_CLEARED}',   NULL,              NULL),
      ('${DEAL_AWAITING}',  'pending_outbox',  '${ROUND_LIVE}'),
      ('${DEAL_NEW_ROUND}', 'pending_outbox',  '${ROUND_OTHER}'),
      ('${DEAL_NO_ROUND}',  'pending_outbox',  '${ROUND_LIVE}');
  `);
  return db;
}

/** A dead rfp_request_delivery job for `dealId`, bound to `round` (null = no parseable round). */
async function queueDeadJob(db: PGlite, dealId: string, round: string | null) {
  const body = round ? { sourceEventId: `crm:deal-stage:opportunity:${round}` } : {};
  await db.query(
    `INSERT INTO public.job_queue (job_type, payload, office_id, status, last_error)
     VALUES ('rfp_request_delivery', $1::jsonb, '${OFFICE}', 'dead', 'exhausted retries')`,
    [JSON.stringify({ dealId, syncHubUrl: "https://synchub.example.com", body })]
  );
}

async function statusOf(db: PGlite, dealId: string): Promise<string | null> {
  const { rows } = await db.query<{ rfp_approval_status: string | null }>(
    `SELECT rfp_approval_status FROM office_test.deals WHERE id = $1`,
    [dealId]
  );
  return rows[0]?.rfp_approval_status ?? null;
}

/** The sweep expects a pool-like with connect(); PGlite is a single connection, so hand it back. */
function poolLike(db: PGlite) {
  return {
    query: (sql: string, params?: unknown[]) => db.query(sql, params as never[]),
    connect: async () => ({
      query: (sql: string, params?: unknown[]) => db.query(sql, params as never[]),
      release: () => {},
    }),
  };
}

describe("runRfpRequestDeadLetterSweep — write guard (real SQL)", () => {
  it("does NOT stamp send_failed on a deal whose RFP cycle was cleared by a move back", async () => {
    const db = await seed();
    await queueDeadJob(db, DEAL_CLEARED, ROUND_LIVE);

    await runRfpRequestDeadLetterSweep({ db: poolLike(db) as never });

    // The whole point: a cleared cycle stays cleared. Writing send_failed here re-locks the deal's
    // scope and makes it un-retriggerable.
    expect(await statusOf(db, DEAL_CLEARED)).toBeNull();
    await db.close();
  });

  it("STILL stamps send_failed on a deal genuinely awaiting this round (the guard is not a mute button)", async () => {
    const db = await seed();
    await queueDeadJob(db, DEAL_AWAITING, ROUND_LIVE);

    const handled = await runRfpRequestDeadLetterSweep({ db: poolLike(db) as never });

    expect(handled).toBe(1);
    expect(await statusOf(db, DEAL_AWAITING)).toBe("send_failed");
    await db.close();
  });

  it("does NOT mark a FRESH round send_failed because a PRIOR round's job died", async () => {
    const db = await seed();
    // Moved back, then re-triggered: the deal is awaiting again, but a different round.
    await queueDeadJob(db, DEAL_NEW_ROUND, ROUND_LIVE);

    await runRfpRequestDeadLetterSweep({ db: poolLike(db) as never });

    expect(await statusOf(db, DEAL_NEW_ROUND)).toBe("pending_outbox");
    await db.close();
  });

  it("FAILS OPEN on a payload with no parseable round, matching its sibling write-backs", async () => {
    const db = await seed();
    await queueDeadJob(db, DEAL_NO_ROUND, null);

    await runRfpRequestDeadLetterSweep({ db: poolLike(db) as never });

    // An unknown round must not silently disable the sweep — the deal is still awaiting, so it flips.
    expect(await statusOf(db, DEAL_NO_ROUND)).toBe("send_failed");
    await db.close();
  });
});
