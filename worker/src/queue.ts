import type { PoolClient } from "pg";
import { pool } from "./db.js";

// How many jobs a single poll tick claims AND runs. Concurrency is bounded by the claim count itself
// (we claim exactly this many and run them all at once), so it doubles as the run-phase cap. Handlers
// open nested pooled connections, so this must stay comfortably under the DB pool max (db.ts: max 10) —
// at ~3 connections per create_project handler, 3 keeps a batch within the pool. Claiming only what we
// immediately run avoids marking extra rows 'processing' that then sit un-started behind a slow handler
// (recoverStaleJobs is startup-only, so those would be invisible to other pollers until a restart).
const RUN_CONCURRENCY = 3;

export type JobHandlerResult =
  | void
  | {
      status: "dead";
      error: string;
    }
  | {
      // A handler can deliberately defer work that is still owned by another durable lease. This is not
      // a failure: preserve the job as pending without treating the handler invocation as completed.
      status: "pending";
      error: string;
      runAfterSeconds: number;
    };

type JobHandler = (payload: any, officeId: string | null) => Promise<JobHandlerResult>;

const jobHandlers = new Map<string, JobHandler>();

export function registerJobHandler(jobType: string, handler: JobHandler) {
  jobHandlers.set(jobType, handler);
}

export function deadJob(error: string): Extract<JobHandlerResult, { status: "dead" }> {
  return { status: "dead", error };
}

/** Return work to the queue at a specific time without recording a terminal completion. */
export function deferJob(
  error: string,
  runAfterSeconds: number,
): Extract<JobHandlerResult, { status: "pending" }> {
  return {
    status: "pending",
    error,
    runAfterSeconds: Math.max(1, Math.ceil(Number.isFinite(runAfterSeconds) ? runAfterSeconds : 1)),
  };
}

let polling = false;

// The terminal state a job's outcome should be written as. Computed once by processJob (or the claim
// requeue path) and replayed VERBATIM by the recovery path — so the intended status AND the exact retry
// backoff survive a write that fails under pool pressure, instead of being reconstructed (which lost
// processJob's backoff and couldn't represent 'completed').
type Outcome =
  | { status: "completed" }
  | { status: "dead"; error: string }
  | { status: "pending"; error: string; runAfterSeconds: number };

// A deferred outcome write bound to the SPECIFIC claimed attempt it belongs to (`attempts` = the row's
// value at claim time). The write guard checks this so a stale intent flushed late can't apply to a LATER
// claim of the same row (a re-claim increments attempts).
type RecoveryIntent = { attempts: number; outcome: Outcome };

// Outcomes whose write failed (pool still exhausted). Kept here and retried at the start of each poll tick
// so the worker SELF-HEALS once the pool recovers — recoverStaleJobs is startup-only (a periodic time-based
// sweep would reclaim LIVE long-running jobs mid-flight), so without this a stranded 'processing' row would
// wait for a restart. Keyed by job id → the exact intent to replay.
const pendingRecoveries = new Map<number, RecoveryIntent>();

/** Test-only: reset module singleton state between cases. */
export function __resetQueueStateForTest() {
  pendingRecoveries.clear();
}

function buildOutcomeUpdate(jobId: number, attempts: number, outcome: Outcome): { sql: string; params: any[] } {
  // Guarded on status='processing' AND attempts: a write only lands on a row still owned by THIS claimed
  // attempt — never one a startup recovery/another actor moved on, and never a LATER re-claim of the same
  // row (which bumps attempts), so a stale deferred write can't stomp a live re-run.
  switch (outcome.status) {
    case "completed":
      return {
        sql: `UPDATE public.job_queue SET status = 'completed', completed_at = NOW() WHERE id = $1 AND status = 'processing' AND attempts = $2`,
        params: [jobId, attempts],
      };
    case "dead":
      return {
        sql: `UPDATE public.job_queue SET status = 'dead', last_error = $1 WHERE id = $2 AND status = 'processing' AND attempts = $3`,
        params: [outcome.error, jobId, attempts],
      };
    case "pending":
      return {
        sql: `UPDATE public.job_queue SET status = 'pending', last_error = $1, run_after = NOW() + make_interval(secs => $2) WHERE id = $3 AND status = 'processing' AND attempts = $4`,
        params: [outcome.error, outcome.runAfterSeconds, jobId, attempts],
      };
  }
}

/** Persist a job's outcome (its normal terminal write). On failure, keep the full intent for a later tick. */
async function attemptRecovery(jobId: number, attempts: number, outcome: Outcome): Promise<void> {
  const { sql, params } = buildOutcomeUpdate(jobId, attempts, outcome);
  try {
    await pool.query(sql, params);
    pendingRecoveries.delete(jobId);
  } catch (err) {
    pendingRecoveries.set(jobId, { attempts, outcome });
    console.error(`[Worker] Job ${jobId} outcome write ('${outcome.status}') failed; will retry next tick:`, err);
  }
}

/** Retry any outcome writes a prior tick couldn't persist. Stops at the first failure (pool still down). */
async function flushPendingRecoveries(): Promise<void> {
  for (const [jobId, { attempts, outcome }] of [...pendingRecoveries]) {
    const { sql, params } = buildOutcomeUpdate(jobId, attempts, outcome);
    try {
      await pool.query(sql, params);
      pendingRecoveries.delete(jobId);
    } catch {
      break; // pool still unavailable — retry the rest on a later tick
    }
  }
}

export async function pollJobs() {
  // Reentrancy guard — skip if a previous poll is still running
  if (polling) return;
  polling = true;

  try {
    // Retry any stranded-job recoveries a previous tick couldn't persist (pool was exhausted) so the worker
    // self-heals without a restart.
    await flushPendingRecoveries();
    // ── Claim phase ──────────────────────────────────────────────────────────────────────────────
    // Hold a connection only long enough to grab + mark the batch, then RELEASE it before running any
    // handler. Handlers open their own nested pool.connect() calls; holding the claim connection through
    // the batch plus each job's nested connections could exhaust the pool (max 10) and block on a
    // connect() with no timeout — which would leave `polling` stuck true and wedge the worker permanently
    // (this is exactly the deadlock the SyncHub photo-link backfill hit).
    let claimed: any[] = [];
    // Rows that were marked 'processing' inside a claim transaction whose COMMIT then errored: the COMMIT
    // may have actually succeeded server-side (a dead socket after commit still rejects on the client), so
    // they can be stuck 'processing' even though `claimed` gets reset. Requeued best-effort below.
    let commitUncertain: any[] = [];
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch (err) {
      // With connectionTimeoutMillis set (db.ts), an exhausted pool REJECTS here. Swallow it as a skipped
      // tick — the next poll retries — rather than letting it escape as an unhandled rejection that would
      // crash the worker (index.ts schedules setInterval(pollJobs) bare).
      console.error("[Worker] Poll: could not acquire a DB connection, skipping this tick:", err);
      return;
    }
    let releaseError: Error | undefined;
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `SELECT * FROM public.job_queue
         WHERE status = 'pending' AND run_after <= NOW()
         ORDER BY created_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [RUN_CONCURRENCY]
      );
      for (const job of result.rows) {
        const handler = jobHandlers.get(job.job_type);
        if (!handler) {
          console.warn(`[Worker] No handler for job type: ${job.job_type}`);
          await client.query(
            "UPDATE public.job_queue SET status = 'dead', last_error = $1 WHERE id = $2",
            [`No handler registered for job type: ${job.job_type}`, job.id]
          );
          continue;
        }
        await client.query(
          "UPDATE public.job_queue SET status = 'processing', attempts = attempts + 1, started_processing_at = NOW() WHERE id = $1",
          [job.id]
        );
        claimed.push(job);
      }
      await client.query("COMMIT");
    } catch (err) {
      // ROLLBACK can itself fail if the connection is already broken. Capture that so the finally can
      // DESTROY the client (release(err)) rather than returning a possibly-poisoned connection — one still
      // mid-transaction — to the pool for the next caller.
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        releaseError = rollbackErr as Error;
      }
      console.error("[Worker] Poll error:", err);
      // The COMMIT may have landed server-side despite this rejection, leaving these rows 'processing'.
      commitUncertain = claimed;
      claimed = [];
    } finally {
      client.release(releaseError);
    }

    // Best-effort requeue of rows a failed/uncertain COMMIT may have left stranded at 'processing' (the run
    // phase skips them because `claimed` was reset). Guarded on status='processing', so it's a no-op if the
    // ROLLBACK actually undid the claim (rows already back to pending). A failed requeue is retried on a
    // later tick (attemptRecovery → pendingRecoveries → flushPendingRecoveries).
    for (const job of commitUncertain) {
      // Bound to the claimed attempt (job.attempts + 1, the value the claim UPDATE wrote). If the COMMIT
      // actually rolled back, the row is back at job.attempts and 'pending' → guard no-matches (harmless);
      // if it landed, the row is 'processing' at job.attempts + 1 → requeued.
      await attemptRecovery(job.id, job.attempts + 1, {
        status: "pending",
        error: "claim commit uncertain — requeued to pending",
        runAfterSeconds: 30,
      });
    }

    // ── Run phase ────────────────────────────────────────────────────────────────────────────────
    // Claim connection already released. At most RUN_CONCURRENCY jobs, so their nested pool.connect()
    // calls (a create_project handler opens ~3: its own client + ensurePublicPhotoLinkForDeal's client +
    // resolveFallbackAdminUser's pool.query) stay under the pool max. processJob persists each job's
    // outcome via attemptRecovery, which self-registers into pendingRecoveries if the write fails — so it
    // never rejects. allSettled is a defensive backstop: if processJob somehow throws (a bug), it can't
    // reject pollJobs (index.ts runs setInterval(pollJobs) bare → unhandled rejection) or clear the
    // `polling` guard while sibling jobs are still running.
    const settled = await Promise.allSettled(claimed.map((job) => processJob(job)));
    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i];
      if (outcome.status === "rejected") {
        const job = claimed[i];
        console.error(`[Worker] Job ${job.id} (${job.job_type}) processing threw unexpectedly:`, outcome.reason);
      }
    }
  } finally {
    polling = false;
  }
}

async function processJob(job: any): Promise<void> {
  const handler = jobHandlers.get(job.job_type);
  if (!handler) return; // Already marked dead above

  // Compute the terminal outcome, THEN persist it via attemptRecovery, bound to THIS attempt (job.attempts
  // is the pre-claim value; the claim UPDATE already incremented the row to job.attempts + 1). attemptRecovery
  // replays this exact outcome (status + backoff) — so a write that fails under pool pressure is retried
  // later as the SAME outcome, a succeeded handler is recovered as 'completed' (never re-run), and the
  // attempts guard stops a late retry from stomping a re-claim of the row.
  const claimedAttempt = job.attempts + 1;
  let outcome: Outcome;
  try {
    const result = await handler(job.payload, job.office_id);
    if (result && result.status === "dead") {
      outcome = { status: "dead", error: result.error };
      console.error(`[Worker] Job ${job.id} (${job.job_type}) rejected without retry: ${result.error}`);
    } else if (result && result.status === "pending") {
      outcome = {
        status: "pending",
        error: result.error,
        runAfterSeconds: Math.max(1, Math.ceil(result.runAfterSeconds)),
      };
      console.log(
        `[Worker] Job ${job.id} (${job.job_type}) deferred for ${outcome.runAfterSeconds}s: ${result.error}`,
      );
    } else {
      outcome = { status: "completed" };
    }
  } catch (err: any) {
    const errorMsg = err.message || String(err);
    if (claimedAttempt >= job.max_attempts) {
      outcome = { status: "dead", error: errorMsg };
      console.error(`[Worker] Job ${job.id} (${job.job_type}) dead after ${claimedAttempt} attempts: ${errorMsg}`);
    } else {
      // Exponential backoff: 3^1=3s, 3^2=9s, 3^3=27s
      const backoffSeconds = Math.pow(3, claimedAttempt);
      outcome = { status: "pending", error: errorMsg, runAfterSeconds: backoffSeconds };
      console.warn(`[Worker] Job ${job.id} (${job.job_type}) failed, retrying in ${backoffSeconds}s: ${errorMsg}`);
    }
  }
  await attemptRecovery(job.id, claimedAttempt, outcome);
}

/**
 * Reset stale "processing" jobs back to pending.
 * Uses started_processing_at (not created_at) to detect truly stuck jobs.
 * Called on worker startup to recover from crashes.
 *
 * Deliberately REQUEUES even when attempts >= max_attempts (does NOT dead-letter here). `attempts` is
 * incremented at CLAIM time, so a crash between the claim and the handler actually running leaves a
 * final-attempt row as 'processing' with attempts == max_attempts even though the handler never ran —
 * dead-lettering it would silently drop legitimate never-run work. From the row alone this is
 * indistinguishable from "handler ran but its outcome-write failed", so startup recovery favors
 * at-least-once (requeue); handlers are expected to be idempotent. The cap IS enforced where we KNOW the
 * handler already executed: processJob computes a 'dead' RecoveryIntent for a final-attempt failure
 * (newAttempts >= max_attempts). Trade-off: a completed-but-unrecorded final attempt that also loses its
 * in-memory pendingRecoveries entry to a restart will run once more — accepted at-least-once behavior, and
 * strictly better than dropping a never-run job.
 */
export async function recoverStaleJobs() {
  const result = await pool.query(
    `UPDATE public.job_queue
     SET status = 'pending', last_error = 'Recovered from stale processing state'
     WHERE status = 'processing'
       AND started_processing_at < NOW() - interval '5 minutes'
     RETURNING id, job_type`
  );
  if (result.rows.length > 0) {
    console.log(`[Worker] Recovered ${result.rows.length} stale jobs:`,
      result.rows.map((r: any) => `${r.id}:${r.job_type}`).join(", ")
    );
  }
}
