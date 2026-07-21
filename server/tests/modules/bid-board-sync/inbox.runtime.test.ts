import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  acceptBidBoardIngestion,
  processBidBoardInboxJob,
  recoverOrphanedInboxJobs,
  readInboxStatusByKey,
  loadInboxRow,
  markInboxProcessing,
  markInboxSucceeded,
  markInboxFailed,
  renewInboxLease,
  BID_BOARD_INGEST_JOB_TYPE,
  type Querier,
} from "../../../src/modules/bid-board-sync/inbox.js";

/**
 * Exercises the durable Bid Board ingestion inbox end-to-end on an in-memory Postgres:
 *  - fast idempotent acceptance (sequential + concurrent dupes → one job; distinct payloads → distinct jobs)
 *  - the async processing state machine (queued→processing→succeeded / retrying / terminal-failed)
 *  - per-office serialization via the injected office lock
 *  - crash recovery (re-enqueue orphaned / stale rows)
 */

let pg: PGlite;
let db: Querier;

const DALLAS = "00000000-0000-4000-8000-000000000001";
const ATLANTA = "00000000-0000-4000-8000-000000000002";
const RUN_UUID = "00000000-0000-4000-8000-0000000000aa"; // run_id column is uuid

async function setupSchema() {
  await pg.exec(`
    CREATE TABLE public.offices (
      id uuid PRIMARY KEY, slug text UNIQUE NOT NULL, is_active boolean NOT NULL DEFAULT true
    );
    INSERT INTO public.offices (id, slug, is_active) VALUES
      ('${DALLAS}', 'dallas', true),
      ('${ATLANTA}', 'atlanta', true);

    CREATE TABLE public.job_queue (
      id bigserial PRIMARY KEY,
      job_type varchar(100) NOT NULL,
      payload jsonb NOT NULL,
      office_id uuid,
      status text NOT NULL DEFAULT 'pending',
      attempts integer NOT NULL DEFAULT 0,
      max_attempts integer NOT NULL DEFAULT 3,
      last_error text,
      started_processing_at timestamptz,
      run_after timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz
    );

    -- Mirrors migration 0188: at most one live bid_board_ingest job per inbox row (dedupes concurrent
    -- recovery enqueues via ON CONFLICT).
    CREATE UNIQUE INDEX job_queue_bbi_one_live_job_idx
      ON public.job_queue ((payload->>'inboxId'))
      WHERE job_type = 'bid_board_ingest' AND status IN ('pending', 'processing');

    CREATE TABLE public.bid_board_ingestion_inbox (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      office_slug text NOT NULL,
      office_id uuid REFERENCES public.offices(id),
      payload_hash text NOT NULL,
      payload jsonb NOT NULL,
      row_count integer NOT NULL DEFAULT 0,
      source_filename text,
      status text NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','processing','succeeded','failed')),
      attempts integer NOT NULL DEFAULT 0,
      max_attempts integer NOT NULL DEFAULT 5,
      run_id uuid,
      metrics jsonb,
      warnings_count integer,
      last_error text,
      queued_at timestamptz NOT NULL DEFAULT now(),
      started_at timestamptz,
      finished_at timestamptz,
      lease_expires_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT bid_board_ingestion_inbox_office_hash_uidx UNIQUE (office_slug, payload_hash)
    );
  `);
}

beforeAll(async () => {
  pg = new PGlite();
  db = {
    query: async (text, params) => {
      const r: any = await pg.query(text, params);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rowCount ?? r.rows?.length ?? 0 };
    },
  };
  await setupSchema();
});

afterAll(async () => {
  await pg?.close?.();
});

// Fresh inbox + queue per test; offices are seeded once and reused.
beforeEach(async () => {
  await pg.exec(`TRUNCATE public.bid_board_ingestion_inbox; TRUNCATE public.job_queue;`);
});

const accept = (overrides: Partial<Parameters<typeof acceptBidBoardIngestion>[1]> = {}) =>
  acceptBidBoardIngestion(db, {
    officeSlug: "dallas",
    payload: { office_slug: "dallas", rows: [{ Name: "Palm Villas" }] },
    payloadHash: "hash-a",
    rowCount: 1,
    sourceFilename: "ProjectList.xlsx",
    ...overrides,
  });

const jobCount = async (inboxId?: string) => {
  const res = inboxId
    ? await db.query(
        `SELECT count(*)::int AS n FROM public.job_queue WHERE job_type=$1 AND payload->>'inboxId'=$2`,
        [BID_BOARD_INGEST_JOB_TYPE, inboxId]
      )
    : await db.query(`SELECT count(*)::int AS n FROM public.job_queue WHERE job_type=$1`, [
        BID_BOARD_INGEST_JOB_TYPE,
      ]);
  return res.rows[0].n as number;
};

const okIngest = (out: Partial<{ runId: string; metrics: unknown; warnings: string[] }> = {}) =>
  vi.fn(async () => ({ runId: RUN_UUID, metrics: { updated: 3 }, warnings: [], ...out }));

const passthroughLock = <T,>(_slug: string, fn: () => Promise<T>) => fn();

describe("acceptBidBoardIngestion (durable idempotent acceptance)", () => {
  it("enqueues one inbox row + one job for a new payload and resolves office_id", async () => {
    const res = await accept();
    expect(res.duplicate).toBe(false);
    expect(res.status).toBe("queued");
    expect(res.idempotencyKey).toBe("hash-a");

    const row = await loadInboxRow(db, res.inboxId);
    expect(row?.office_slug).toBe("dallas");
    expect(row?.office_id).toBe(DALLAS);
    expect(row?.status).toBe("queued");
    expect(await jobCount(res.inboxId)).toBe(1);
  });

  it("dedupes a SEQUENTIAL duplicate to the same job (retry after a 502)", async () => {
    const first = await accept();
    const second = await accept();
    expect(second.duplicate).toBe(true);
    expect(second.inboxId).toBe(first.inboxId);
    expect(await jobCount()).toBe(1); // NOT two overlapping imports
  });

  it("dedupes CONCURRENT duplicates to one logical ingestion", async () => {
    const [a, b] = await Promise.all([accept(), accept()]);
    expect(a.inboxId).toBe(b.inboxId);
    // exactly one row and one job despite two simultaneous requests
    const rows = await db.query(`SELECT count(*)::int AS n FROM public.bid_board_ingestion_inbox`);
    expect(rows.rows[0].n).toBe(1);
    expect(await jobCount()).toBe(1);
  });

  it("creates separate jobs for different payload hashes", async () => {
    const a = await accept({ payloadHash: "hash-a" });
    const b = await accept({ payloadHash: "hash-b" });
    expect(a.inboxId).not.toBe(b.inboxId);
    expect(await jobCount()).toBe(2);
  });

  it("reports the CURRENT status of a duplicate (e.g. already processing)", async () => {
    const first = await accept();
    await db.query(`UPDATE public.bid_board_ingestion_inbox SET status='processing' WHERE id=$1`, [
      first.inboxId,
    ]);
    const dup = await accept();
    expect(dup.duplicate).toBe(true);
    expect(dup.status).toBe("processing");
  });
});

describe("processBidBoardInboxJob (async processing state machine)", () => {
  it("runs the importer under the office lock and records success + metrics", async () => {
    const { inboxId } = await accept();
    const ingest = okIngest({ warnings: ["w1", "w2"] });
    const lock = vi.fn(passthroughLock);

    const outcome = await processBidBoardInboxJob({ db, inboxId, ingest, withOfficeLock: lock });

    expect(outcome).toBe("succeeded");
    expect(ingest).toHaveBeenCalledOnce();
    expect(lock).toHaveBeenCalledWith("dallas", expect.any(Function));
    const row = await readInboxStatusByKey(db, "dallas", "hash-a");
    expect(row?.status).toBe("succeeded");
    expect(row?.run_id).toBe(RUN_UUID);
    expect(row?.warnings_count).toBe(2);
    expect(row?.attempts).toBe(1);
    expect(row?.finished_at).toBeTruthy();
    // The heavy payload is dropped on success (row retained for idempotency/status/metrics).
    const full = await loadInboxRow(db, inboxId);
    expect(full?.payload).toEqual({});
  });

  it("is idempotent: an already-succeeded row is a no-op and does NOT re-run the importer", async () => {
    const { inboxId } = await accept();
    const ingest = okIngest();
    await processBidBoardInboxJob({ db, inboxId, ingest, withOfficeLock: passthroughLock });
    ingest.mockClear();

    const outcome = await processBidBoardInboxJob({ db, inboxId, ingest, withOfficeLock: passthroughLock });
    expect(outcome).toBe("noop");
    expect(ingest).not.toHaveBeenCalled();
  });

  it("DEFERS (does not complete) when the row is live-LEASED by another handler", async () => {
    const { inboxId } = await accept();
    // Another replica is actively importing: 'processing' with a lease well in the future + attempts < max.
    // markInboxProcessing yields null (won't steal a live lease); the job must be RESCHEDULED, not completed.
    await db.query(
      `UPDATE public.bid_board_ingestion_inbox
         SET status='processing', attempts=1, lease_expires_at = now() + interval '3600 seconds' WHERE id=$1`,
      [inboxId]
    );
    const ingest = okIngest();

    const outcome = await processBidBoardInboxJob({ db, inboxId, ingest, withOfficeLock: passthroughLock });

    expect(outcome).toMatchObject({ status: "deferred" });
    // Bounded to the lease TTL (+buffer), never the full hour the lease has left.
    const runAfterSeconds = (outcome as { runAfterSeconds: number }).runAfterSeconds;
    expect(runAfterSeconds).toBeGreaterThan(0);
    expect(runAfterSeconds).toBeLessThanOrEqual(185);
    expect(ingest).not.toHaveBeenCalled(); // the live import is NOT double-run
    const row = await loadInboxRow(db, inboxId);
    expect(row?.status).toBe("processing"); // left leased for its owner
  });

  it("NOOPs (completes) a terminal 'failed' row rather than deferring", async () => {
    const { inboxId } = await accept();
    await db.query(`UPDATE public.bid_board_ingestion_inbox SET status='failed', attempts=1 WHERE id=$1`, [inboxId]);
    const ingest = okIngest();

    const outcome = await processBidBoardInboxJob({ db, inboxId, ingest, withOfficeLock: passthroughLock });

    expect(outcome).toBe("noop");
    expect(ingest).not.toHaveBeenCalled();
  });

  it("NOOPs an attempts-EXHAUSTED 'processing' row (lets the job dead-letter) — never defers forever", async () => {
    const { inboxId } = await accept();
    // At the attempts cap even with a live lease: markInboxProcessing still yields null, but deferring would
    // loop forever, so this is a noop — the job dead-letters on its own final attempt.
    await db.query(
      `UPDATE public.bid_board_ingestion_inbox
         SET status='processing', attempts=max_attempts, lease_expires_at = now() + interval '3600 seconds' WHERE id=$1`,
      [inboxId]
    );
    const ingest = okIngest();

    const outcome = await processBidBoardInboxJob({ db, inboxId, ingest, withOfficeLock: passthroughLock });

    expect(outcome).toBe("noop");
    expect(ingest).not.toHaveBeenCalled();
  });

  it("re-checks AFTER the lock: skips the import if a concurrent holder committed it while we waited (no duplicate)", async () => {
    const { inboxId } = await accept();
    const ingest = okIngest();
    // markInboxProcessing claims this row ('processing'), then a duplicate job — a concurrent recovery
    // re-enqueue (#2) or a reclaimed still-running job (#3) — commits the import and marks the row succeeded
    // while we block on the office lock. The lock only serializes; the post-lock recheck is what prevents the
    // second handler from re-running the already-committed import.
    const lockLosesRace = async <T,>(_slug: string, fn: () => Promise<T>): Promise<T> => {
      await db.query(
        `UPDATE public.bid_board_ingestion_inbox
         SET status='succeeded', run_id=$2, finished_at=now(), payload='{}'::jsonb WHERE id=$1`,
        [inboxId, RUN_UUID]
      );
      return fn();
    };

    const outcome = await processBidBoardInboxJob({ db, inboxId, ingest, withOfficeLock: lockLosesRace });

    expect(outcome).toBe("noop");
    expect(ingest).not.toHaveBeenCalled(); // the committed import is NOT re-run
    const row = await readInboxStatusByKey(db, "dallas", "hash-a");
    expect(row?.status).toBe("succeeded"); // left exactly as the winner recorded it
  });

  it("still re-runs a genuinely orphaned 'processing' row (worker died mid-import) — the recheck only skips TERMINAL rows", async () => {
    const { inboxId } = await accept();
    // A worker claimed this row then died mid-import: it is 'processing' but never reached a terminal state,
    // and recovery re-enqueued it. Claiming + rechecking must let the import actually run (not over-skip).
    await db.query(
      `UPDATE public.bid_board_ingestion_inbox
       SET status='processing', started_at = now() - interval '30 minutes', attempts=1 WHERE id=$1`,
      [inboxId]
    );
    const ingest = okIngest();

    const outcome = await processBidBoardInboxJob({ db, inboxId, ingest, withOfficeLock: passthroughLock });

    expect(outcome).toBe("succeeded");
    expect(ingest).toHaveBeenCalledOnce(); // recovery DID re-run the unfinished import
    const row = await readInboxStatusByKey(db, "dallas", "hash-a");
    expect(row?.status).toBe("succeeded");
  });

  it("a NON-terminal failure rethrows and leaves the row 'processing' (so status stays honest during backoff)", async () => {
    const { inboxId } = await accept(); // max_attempts default 5, this is attempt 1
    const ingest = vi.fn(async () => {
      throw new Error("deal row deadlock");
    });

    await expect(
      processBidBoardInboxJob({ db, inboxId, ingest, withOfficeLock: passthroughLock })
    ).rejects.toThrow("deal row deadlock");

    const row = await readInboxStatusByKey(db, "dallas", "hash-a");
    expect(row?.status).toBe("processing"); // NOT 'failed' — the job queue will retry
    expect(row?.last_error).toContain("deadlock");
    expect(row?.finished_at).toBeNull();
  });

  it("a TERMINAL failure (final attempt) rethrows and marks the row 'failed'", async () => {
    const { inboxId } = await accept();
    // Pretend prior attempts already ran: set attempts to max-1 so this run reaches the cap.
    await db.query(`UPDATE public.bid_board_ingestion_inbox SET attempts=4, max_attempts=5 WHERE id=$1`, [
      inboxId,
    ]);
    const ingest = vi.fn(async () => {
      throw new Error("permanent schema error");
    });

    await expect(
      processBidBoardInboxJob({ db, inboxId, ingest, withOfficeLock: passthroughLock })
    ).rejects.toThrow("permanent schema error");

    const row = await readInboxStatusByKey(db, "dallas", "hash-a");
    expect(row?.status).toBe("failed"); // terminal
    expect(row?.attempts).toBe(5);
    expect(row?.last_error).toContain("permanent schema error");
    expect(row?.finished_at).toBeTruthy();
  });

  it("does NOT resurrect a terminally-failed row (a drifting job retry is a no-op)", async () => {
    const { inboxId } = await accept();
    await db.query(`UPDATE public.bid_board_ingestion_inbox SET status='failed', attempts=5 WHERE id=$1`, [
      inboxId,
    ]);
    const ingest = okIngest();
    const outcome = await processBidBoardInboxJob({ db, inboxId, ingest, withOfficeLock: passthroughLock });
    expect(outcome).toBe("noop");
    expect(ingest).not.toHaveBeenCalled();
    const row = await readInboxStatusByKey(db, "dallas", "hash-a");
    expect(row?.status).toBe("failed"); // unchanged
  });

  it("serializes processing per office and allows different offices to overlap", async () => {
    // Two DISTINCT payloads for the SAME office, plus one for another office.
    const d1 = await accept({ payloadHash: "d1" });
    const d2 = await accept({ payloadHash: "d2" });
    const a1 = await accept({
      officeSlug: "atlanta",
      payloadHash: "a1",
      payload: { office_slug: "atlanta", rows: [] },
    });

    // Keyed async mutex — the contract the real worker fulfils with a pg session advisory lock.
    const chains = new Map<string, Promise<void>>();
    const withKeyedLock = async <T,>(slug: string, fn: () => Promise<T>): Promise<T> => {
      const prev = chains.get(slug) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      chains.set(slug, prev.then(() => gate));
      await prev;
      try {
        return await fn();
      } finally {
        release();
      }
    };

    // One shared counter proves cross-office overlap; a dallas-only counter proves same-office exclusion.
    let live = 0;
    let globalMax = 0;
    let dallasLive = 0;
    let dallasMax = 0;
    const mkIngest = (office: string) =>
      vi.fn(async () => {
        live++;
        globalMax = Math.max(globalMax, live);
        if (office === "dallas") {
          dallasLive++;
          dallasMax = Math.max(dallasMax, dallasLive);
        }
        await new Promise((r) => setTimeout(r, 15));
        if (office === "dallas") dallasLive--;
        live--;
        return { runId: RUN_UUID, metrics: {}, warnings: [] };
      });
    const dallasIngest = mkIngest("dallas");

    await Promise.all([
      processBidBoardInboxJob({ db, inboxId: d1.inboxId, ingest: dallasIngest, withOfficeLock: withKeyedLock }),
      processBidBoardInboxJob({ db, inboxId: d2.inboxId, ingest: dallasIngest, withOfficeLock: withKeyedLock }),
      processBidBoardInboxJob({ db, inboxId: a1.inboxId, ingest: mkIngest("atlanta"), withOfficeLock: withKeyedLock }),
    ]);

    // Same office → never two imports in flight at once.
    expect(dallasMax).toBe(1);
    expect(dallasIngest).toHaveBeenCalledTimes(2);
    // Different offices DID overlap → processing is per-office, not globally serialized.
    expect(globalMax).toBe(2);
    const rows = await db.query(
      `SELECT count(*)::int AS n FROM public.bid_board_ingestion_inbox WHERE status='succeeded'`
    );
    expect(rows.rows[0].n).toBe(3);
  });
});

describe("recoverOrphanedInboxJobs (crash recovery)", () => {
  it("re-enqueues a 'queued' inbox row that has no live job", async () => {
    const { inboxId } = await accept();
    // Simulate the job insert never landing.
    await db.query(`DELETE FROM public.job_queue`);
    expect(await jobCount()).toBe(0);

    const recovered = await recoverOrphanedInboxJobs(db);
    expect(recovered).toBe(1);
    expect(await jobCount(inboxId)).toBe(1);
  });

  it("does NOT duplicate a job when a live one already exists", async () => {
    const { inboxId } = await accept();
    expect(await jobCount(inboxId)).toBe(1);
    const recovered = await recoverOrphanedInboxJobs(db);
    expect(recovered).toBe(0);
    expect(await jobCount(inboxId)).toBe(1);
  });

  it("enforces at most ONE live job per inbox row — a concurrent recovery enqueue is deduped by the unique index", async () => {
    const { inboxId } = await accept(); // inbox row + one live 'pending' job
    expect(await jobCount(inboxId)).toBe(1);
    // Simulate a second worker's recovery that passed its own NOT EXISTS snapshot before the first committed,
    // and tries to enqueue a second live job for the same inbox row. The partial unique index + ON CONFLICT
    // DO NOTHING drops it, so the shared inbox attempts counter can't be double-charged.
    const dup = await db.query(
      `INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after, max_attempts)
       VALUES ($1, jsonb_build_object('inboxId', $2::text), NULL, 'pending', NOW(), 5)
       ON CONFLICT ((payload->>'inboxId'))
         WHERE job_type = 'bid_board_ingest' AND status IN ('pending', 'processing')
         DO NOTHING
       RETURNING id`,
      [BID_BOARD_INGEST_JOB_TYPE, inboxId]
    );
    expect(dup.rows.length).toBe(0); // deduped — no second job
    expect(await jobCount(inboxId)).toBe(1);
  });

  it("never re-enqueues terminal ('succeeded'/'failed') rows", async () => {
    const succeeded = await accept({ payloadHash: "ok" });
    const failed = await accept({ payloadHash: "bad" });
    await db.query(`DELETE FROM public.job_queue`);
    await db.query(`UPDATE public.bid_board_ingestion_inbox SET status='succeeded' WHERE id=$1`, [succeeded.inboxId]);
    await db.query(`UPDATE public.bid_board_ingestion_inbox SET status='failed' WHERE id=$1`, [failed.inboxId]);

    const recovered = await recoverOrphanedInboxJobs(db);
    expect(recovered).toBe(0);
    expect(await jobCount()).toBe(0);
  });

  it("re-enqueues a STALE 'processing' row (worker died mid-import) but not a fresh one", async () => {
    const stale = await accept({ payloadHash: "stale" });
    const fresh = await accept({ payloadHash: "fresh" });
    await db.query(`DELETE FROM public.job_queue`);
    await db.query(
      `UPDATE public.bid_board_ingestion_inbox SET status='processing', started_at = now() - interval '30 minutes' WHERE id=$1`,
      [stale.inboxId]
    );
    await db.query(
      `UPDATE public.bid_board_ingestion_inbox SET status='processing', started_at = now() WHERE id=$1`,
      [fresh.inboxId]
    );

    const recovered = await recoverOrphanedInboxJobs(db, { staleProcessingMinutes: 10 });
    expect(recovered).toBe(1);
    expect(await jobCount(stale.inboxId)).toBe(1);
    expect(await jobCount(fresh.inboxId)).toBe(0);
  });

  it("does NOT re-enqueue a stale 'processing' row whose lease is still fresh (live import, queue row vanished)", async () => {
    const { inboxId } = await accept();
    await db.query(`DELETE FROM public.job_queue`); // queue row gone (e.g. generic recoverStaleJobs reclaimed it)
    // stale started_at but a LIVE handler still renewing the lease.
    await db.query(
      `UPDATE public.bid_board_ingestion_inbox
       SET status='processing', started_at = now() - interval '30 minutes', lease_expires_at = now() + interval '2 minutes' WHERE id=$1`,
      [inboxId]
    );
    const recovered = await recoverOrphanedInboxJobs(db, { staleProcessingMinutes: 10 });
    expect(recovered).toBe(0); // fresh lease → not re-enqueued (no churn of no-op jobs)
    expect(await jobCount(inboxId)).toBe(0);
  });

  it("marks a STALE attempts-exhausted 'processing' row terminally 'failed' (worker died on the final attempt) without re-enqueueing", async () => {
    const { inboxId } = await accept();
    await db.query(`DELETE FROM public.job_queue`);
    await db.query(
      `UPDATE public.bid_board_ingestion_inbox SET status='processing', attempts=5, max_attempts=5, started_at = now() - interval '30 minutes' WHERE id=$1`,
      [inboxId]
    );
    const recovered = await recoverOrphanedInboxJobs(db);
    expect(recovered).toBe(0); // not re-enqueued
    const row = await loadInboxRow(db, inboxId);
    expect(row?.status).toBe("failed"); // reaches a terminal state so SyncHub can alert
    expect(row?.finished_at).toBeTruthy();
  });

  it("does NOT fail a FRESH attempts-exhausted 'processing' row (its final attempt may still be running)", async () => {
    const { inboxId } = await accept();
    await db.query(`DELETE FROM public.job_queue`);
    await db.query(
      `UPDATE public.bid_board_ingestion_inbox SET status='processing', attempts=5, max_attempts=5, started_at = now() WHERE id=$1`,
      [inboxId]
    );
    const recovered = await recoverOrphanedInboxJobs(db, { staleProcessingMinutes: 10 });
    expect(recovered).toBe(0);
    const row = await loadInboxRow(db, inboxId);
    expect(row?.status).toBe("processing"); // untouched — not stale yet
  });

  it("does NOT terminalize a STALE attempts-exhausted 'processing' row while a LIVE job still owns it (slow final attempt)", async () => {
    const { inboxId } = await accept(); // leaves a live pending job in place
    await db.query(
      `UPDATE public.bid_board_ingestion_inbox SET status='processing', attempts=5, max_attempts=5, started_at = now() - interval '30 minutes' WHERE id=$1`,
      [inboxId]
    );
    const recovered = await recoverOrphanedInboxJobs(db, { staleProcessingMinutes: 10 });
    expect(recovered).toBe(0);
    const row = await loadInboxRow(db, inboxId);
    expect(row?.status).toBe("processing"); // a live job owns it → left alone (not falsely failed)
  });

  it("does NOT terminalize a LIVE final-attempt import (fresh lease) even with no live job (reclaimed + noop'd)", async () => {
    // The scenario the lease guards: a healthy final attempt whose queue job was reclaimed, noop-claimed by
    // another worker (blocked by the lease), and completed — so NO live job remains — while the original
    // handler is STILL running and renewing the lease. step (a) must NOT 'fail' it (its later success would be
    // blocked by the terminal-state guard).
    const { inboxId } = await accept();
    await db.query(`DELETE FROM public.job_queue`); // no live job
    await db.query(
      `UPDATE public.bid_board_ingestion_inbox
       SET status='processing', attempts=5, max_attempts=5, started_at = now() - interval '30 minutes',
           lease_expires_at = now() + interval '2 minutes' WHERE id=$1`,
      [inboxId]
    );
    await recoverOrphanedInboxJobs(db, { staleProcessingMinutes: 10 });
    expect((await loadInboxRow(db, inboxId))?.status).toBe("processing"); // fresh lease → alive → left alone
  });

  it("recovery of a stale FINAL-attempt row does NOT re-import it — claim noops (attempts stay at max), then terminalizes", async () => {
    const { inboxId } = await accept();
    await db.query(`DELETE FROM public.job_queue`); // no live job
    // Worker died on the final attempt: processing, attempts == max, stale, lease expired.
    await db.query(
      `UPDATE public.bid_board_ingestion_inbox
       SET status='processing', attempts=5, max_attempts=5, started_at = now() - interval '30 minutes',
           lease_expires_at = now() - interval '5 minutes' WHERE id=$1`,
      [inboxId]
    );
    const ingest = okIngest();
    const outcome = await processBidBoardInboxJob({ db, inboxId, ingest, withOfficeLock: passthroughLock });
    expect(outcome).toBe("noop"); // markInboxProcessing's attempts<max_attempts guard blocks the re-claim
    expect(ingest).not.toHaveBeenCalled(); // the exhausted row is NOT imported a 6th time
    expect((await loadInboxRow(db, inboxId))?.attempts).toBe(5); // not bumped past max

    await recoverOrphanedInboxJobs(db); // no live job + exhausted + lease expired → terminalize
    expect((await loadInboxRow(db, inboxId))?.status).toBe("failed");
  });

  it("step (0) does NOT reclaim a stale job whose inbox lease is still fresh (live long import)", async () => {
    const { inboxId } = await accept();
    await db.query(
      `UPDATE public.bid_board_ingestion_inbox SET status='processing', lease_expires_at = now() + interval '2 minutes' WHERE id=$1`,
      [inboxId]
    );
    await db.query(
      `UPDATE public.job_queue SET status='processing', started_processing_at = now() - interval '30 minutes'
       WHERE job_type=$1 AND payload->>'inboxId'=$2`,
      [BID_BOARD_INGEST_JOB_TYPE, inboxId]
    );
    await recoverOrphanedInboxJobs(db, { staleJobMinutes: 15 });
    const r = await db.query(
      `SELECT status FROM public.job_queue WHERE job_type=$1 AND payload->>'inboxId'=$2`,
      [BID_BOARD_INGEST_JOB_TYPE, inboxId]
    );
    expect(r.rows[0].status).toBe("processing"); // fresh lease → the live import's job is left running
  });

  it("reclaims a 'processing' bid_board_ingest job stuck past the window (worker crashed without restart)", async () => {
    const { inboxId } = await accept();
    await db.query(
      `UPDATE public.job_queue SET status='processing', started_processing_at = now() - interval '30 minutes'
       WHERE job_type=$1 AND payload->>'inboxId'=$2`,
      [BID_BOARD_INGEST_JOB_TYPE, inboxId]
    );
    await recoverOrphanedInboxJobs(db, { staleJobMinutes: 15 });
    const r = await db.query(
      `SELECT status FROM public.job_queue WHERE job_type=$1 AND payload->>'inboxId'=$2`,
      [BID_BOARD_INGEST_JOB_TYPE, inboxId]
    );
    expect(r.rows[0].status).toBe("pending"); // reclaimed so a fresh worker can pick it up
  });

  it("does NOT reclaim a fresh 'processing' job (still legitimately running)", async () => {
    const { inboxId } = await accept();
    await db.query(
      `UPDATE public.job_queue SET status='processing', started_processing_at = now()
       WHERE job_type=$1 AND payload->>'inboxId'=$2`,
      [BID_BOARD_INGEST_JOB_TYPE, inboxId]
    );
    await recoverOrphanedInboxJobs(db, { staleJobMinutes: 15 });
    const r = await db.query(
      `SELECT status FROM public.job_queue WHERE job_type=$1 AND payload->>'inboxId'=$2`,
      [BID_BOARD_INGEST_JOB_TYPE, inboxId]
    );
    expect(r.rows[0].status).toBe("processing"); // untouched
  });

  it("retention: deletes terminal rows past the window, keeps recent ones", async () => {
    const old = await accept({ payloadHash: "old" });
    const recent = await accept({ payloadHash: "recent" });
    await db.query(
      `UPDATE public.bid_board_ingestion_inbox SET status='succeeded', finished_at = now() - interval '30 days' WHERE id=$1`,
      [old.inboxId]
    );
    await db.query(
      `UPDATE public.bid_board_ingestion_inbox SET status='succeeded', finished_at = now() WHERE id=$1`,
      [recent.inboxId]
    );
    await recoverOrphanedInboxJobs(db, { retentionDays: 14 });
    expect(await loadInboxRow(db, old.inboxId)).toBeNull();
    expect(await loadInboxRow(db, recent.inboxId)).not.toBeNull();
  });
});

describe("terminal-write status guards (idempotent against a raced terminal state)", () => {
  it("markInboxSucceeded is a no-op on an already-'failed' row (never resurrects it to succeeded)", async () => {
    const { inboxId } = await accept();
    await db.query(
      `UPDATE public.bid_board_ingestion_inbox SET status='failed', attempts=5, last_error='dead', finished_at=now() WHERE id=$1`,
      [inboxId]
    );
    await markInboxSucceeded(db, inboxId, { runId: RUN_UUID, metrics: {}, warningsCount: 0 });
    const row = await readInboxStatusByKey(db, "dallas", "hash-a");
    expect(row?.status).toBe("failed"); // status='processing' guard held — not flipped to succeeded
    expect(row?.run_id).toBeNull();
  });

  it("markInboxFailed(terminal) is a no-op on an already-'succeeded' row (never clobbers the outcome)", async () => {
    const { inboxId } = await accept();
    await db.query(
      `UPDATE public.bid_board_ingestion_inbox SET status='succeeded', run_id=$2, finished_at=now() WHERE id=$1`,
      [inboxId, RUN_UUID]
    );
    await markInboxFailed(db, inboxId, { error: "late failure after commit", terminal: true, attempt: 1 });
    const row = await readInboxStatusByKey(db, "dallas", "hash-a");
    expect(row?.status).toBe("succeeded"); // status='processing' guard held — not flipped to failed
    expect(row?.run_id).toBe(RUN_UUID);
  });
});

describe("in-flight lease (heartbeat) — a live import can't be double-claimed", () => {
  it("does NOT re-claim a 'processing' row whose lease is still valid (a live handler owns it)", async () => {
    const { inboxId } = await accept();
    const first = await markInboxProcessing(db, inboxId); // claims: processing + fresh lease
    expect(first).not.toBeNull();
    // A reclaimed/concurrent job tries to claim the SAME live row — blocked by the valid lease.
    const second = await markInboxProcessing(db, inboxId);
    expect(second).toBeNull();
    const row = await loadInboxRow(db, inboxId);
    expect(row?.attempts).toBe(1); // NOT double-charged — the key harm this prevents
  });

  it("DOES re-claim a 'processing' row whose lease has EXPIRED (the previous handler died)", async () => {
    const { inboxId } = await accept();
    await markInboxProcessing(db, inboxId);
    await db.query(
      `UPDATE public.bid_board_ingestion_inbox SET lease_expires_at = now() - interval '1 minute' WHERE id=$1`,
      [inboxId]
    );
    const reclaimed = await markInboxProcessing(db, inboxId);
    expect(reclaimed).not.toBeNull(); // genuine recovery of a dead handler
    expect(reclaimed?.attempts).toBe(2);
  });

  it("a non-terminal failure RELEASES the lease so the backoff retry re-claims immediately", async () => {
    const { inboxId } = await accept();
    await markInboxProcessing(db, inboxId); // attempt 1, fresh lease
    await markInboxFailed(db, inboxId, { error: "deal row deadlock", terminal: false, attempt: 1 });
    expect((await loadInboxRow(db, inboxId))?.lease_expires_at).toBeNull(); // lease released
    const retry = await markInboxProcessing(db, inboxId); // re-claimable even before TTL elapses
    expect(retry).not.toBeNull();
    expect(retry?.attempts).toBe(2);
  });

  it("a non-terminal failure bound to a STALE attempt does NOT clear a newer attempt's lease", async () => {
    const { inboxId } = await accept();
    await markInboxProcessing(db, inboxId); // attempt 1
    // Attempt 1's lease lapsed and another replica RECLAIMED the row (attempt 2, fresh lease).
    await db.query(
      `UPDATE public.bid_board_ingestion_inbox SET lease_expires_at = now() - interval '1 minute' WHERE id=$1`,
      [inboxId]
    );
    const reclaimed = await markInboxProcessing(db, inboxId); // attempt 2, fresh lease
    expect(reclaimed?.attempts).toBe(2);
    // The stale attempt-1 handler now unwinds with a non-terminal failure — bound to attempt 1, it must NOT
    // clear attempt 2's live lease (which would let recovery reclaim the running import).
    await markInboxFailed(db, inboxId, { error: "stale attempt unwinding", terminal: false, attempt: 1 });
    const row = await loadInboxRow(db, inboxId);
    expect(row?.lease_expires_at).not.toBeNull(); // attempt 2's fresh lease is intact
    expect(row?.attempts).toBe(2);
  });

  it("renewInboxLease extends a live lease but no-ops on a terminal row", async () => {
    const { inboxId } = await accept();
    await markInboxProcessing(db, inboxId);
    await db.query(
      `UPDATE public.bid_board_ingestion_inbox SET lease_expires_at = now() + interval '3 seconds' WHERE id=$1`,
      [inboxId]
    );
    await renewInboxLease(db, inboxId);
    const renewed = await loadInboxRow(db, inboxId);
    expect(new Date(renewed!.lease_expires_at!).getTime()).toBeGreaterThan(Date.now() + 60_000);

    await db.query(`UPDATE public.bid_board_ingestion_inbox SET status='succeeded' WHERE id=$1`, [inboxId]);
    const before = (await loadInboxRow(db, inboxId))!.lease_expires_at;
    await renewInboxLease(db, inboxId); // status != 'processing' → no-op
    expect(String((await loadInboxRow(db, inboxId))!.lease_expires_at)).toBe(String(before));
  });
});

describe("readInboxStatusByKey", () => {
  it("returns null for an unknown key", async () => {
    expect(await readInboxStatusByKey(db, "dallas", "nope")).toBeNull();
  });
});
