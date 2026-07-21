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

// Client-side timeout for the poller's OWN queue queries (the claim transaction + the outcome writes). The
// worker pool sets no query_timeout/keepalive (db.ts), so a silently-dead PostgreSQL socket would otherwise
// hang a client.query / pool.query FOREVER — wedging the reentrancy guard. For the dedicated bid_board_ingest
// poller that means every later import goes unclaimed until a process restart (the main poller can't take them
// — it excludes the type). Generous vs a normal sub-second claim/outcome write. `let` so tests can shrink it.
let QUEUE_QUERY_TIMEOUT_MS = 30_000;

/** Test-only: shrink the queue-query timeout so a dead-socket hang can be exercised without a 30s wait. */
export function __setQueueQueryTimeoutForTest(ms: number) {
  QUEUE_QUERY_TIMEOUT_MS = ms;
}

class QueueQueryTimeout extends Error {
  constructor(label: string) {
    super(`[Worker] ${label} exceeded ${QUEUE_QUERY_TIMEOUT_MS}ms — assuming a dead socket`);
    this.name = "QueueQueryTimeout";
  }
}

// Race a query against QUEUE_QUERY_TIMEOUT_MS. It can't CANCEL the underlying query (a dead socket never
// settles), so on a QueueQueryTimeout the CALLER must DESTROY the connection rather than return it to the pool.
function withQueueTimeout<T>(query: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new QueueQueryTimeout(label)), QUEUE_QUERY_TIMEOUT_MS);
  });
  return Promise.race([query, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** Persist a job's outcome (its normal terminal write). On failure, keep the full intent for a later tick. */
async function attemptRecovery(jobId: number, attempts: number, outcome: Outcome): Promise<void> {
  const { sql, params } = buildOutcomeUpdate(jobId, attempts, outcome);
  try {
    // Time-bounded so a dead socket can't hang the run phase (and the reentrancy guard). pool.query manages the
    // connection; the pool's TCP keepAlive (db.ts) evicts a genuinely-dead one. A timeout leaves the intent in
    // pendingRecoveries for a later tick, exactly like any other write failure.
    await withQueueTimeout(pool.query(sql, params), `job ${jobId} outcome write`);
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
      await withQueueTimeout(pool.query(sql, params), `job ${jobId} outcome flush`);
      pendingRecoveries.delete(jobId);
    } catch {
      break; // pool still unavailable / dead socket — retry the rest on a later tick
    }
  }
}

// The main poller EXCLUDES bid_board_ingest; that job type runs for MINUTES and gets its own dedicated poller
// (pollBidBoardIngestJobs) so a long import can't hold a shared reentrancy guard across its run phase and
// starve the email / domain-event / delivery jobs the main poller would otherwise claim on later ticks.
const MAIN_POLL_JOB_TYPE_SQL = "AND job_type <> 'bid_board_ingest'";
const BID_BOARD_INGEST_JOB_TYPE_SQL = "AND job_type = 'bid_board_ingest'";
// One import at a time on the dedicated poller: imports are already per-office-serialized by an advisory lock,
// and each holds a lock connection + the importer's queries, so a single in-flight import keeps this poller
// well under the DB pool max even while the main poller runs its own RUN_CONCURRENCY batch.
const BID_BOARD_INGEST_CONCURRENCY = 1;

// Claim up to `limit` matching 'pending' rows in one short transaction, release the claim connection, then run
// the claimed handlers. Shared by the main poller and the dedicated bid_board_ingest poller (each passes its
// own job_type predicate + limit and owns its own reentrancy guard), so the intricate claim / commit-uncertain
// / pool-safety logic lives in exactly one place. `jobTypeSql` is a hardcoded predicate constant (never user
// input), appended into the claim WHERE.
async function claimAndRunJobs(jobTypeSql: string, limit: number): Promise<void> {
  // ── Claim phase ──────────────────────────────────────────────────────────────────────────────
  // Hold a connection only long enough to grab + mark the batch, then RELEASE it before running any
  // handler. Handlers open their own nested pool.connect() calls; holding the claim connection through
  // the batch plus each job's nested connections could exhaust the pool (max 10) and block on a
  // connect() with no timeout — which would leave the reentrancy guard stuck true and wedge the worker
  // permanently (this is exactly the deadlock the SyncHub photo-link backfill hit).
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
    // crash the worker (index.ts schedules the pollers via bare setInterval).
    console.error("[Worker] Poll: could not acquire a DB connection, skipping this tick:", err);
    return;
  }
  let releaseError: Error | undefined;
  try {
    // Every claim query is time-bounded (withQueueTimeout): a silently-dead socket can't hang the transaction
    // and, with it, the poller's reentrancy guard, indefinitely.
    await withQueueTimeout(client.query("BEGIN"), "claim BEGIN");
    const result = await withQueueTimeout(
      client.query(
        `SELECT * FROM public.job_queue
         WHERE status = 'pending' AND run_after <= NOW() ${jobTypeSql}
         ORDER BY created_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [limit]
      ),
      "claim SELECT"
    );
    for (const job of result.rows) {
      const handler = jobHandlers.get(job.job_type);
      if (!handler) {
        console.warn(`[Worker] No handler for job type: ${job.job_type}`);
        await withQueueTimeout(
          client.query(
            "UPDATE public.job_queue SET status = 'dead', last_error = $1 WHERE id = $2",
            [`No handler registered for job type: ${job.job_type}`, job.id]
          ),
          "claim dead-mark"
        );
        continue;
      }
      await withQueueTimeout(
        client.query(
          "UPDATE public.job_queue SET status = 'processing', attempts = attempts + 1, started_processing_at = NOW() WHERE id = $1",
          [job.id]
        ),
        "claim mark-processing"
      );
      claimed.push(job);
    }
    await withQueueTimeout(client.query("COMMIT"), "claim COMMIT");
  } catch (err) {
    // A query TIMEOUT means a dead socket — do NOT attempt ROLLBACK (it would hang too); just DESTROY the
    // client via releaseError below. Any OTHER error: attempt a time-bounded ROLLBACK (which can itself fail
    // on a broken connection) so the finally can destroy rather than return a poisoned, mid-transaction client.
    if (err instanceof QueueQueryTimeout) {
      releaseError = err;
    } else {
      try {
        await withQueueTimeout(client.query("ROLLBACK"), "claim ROLLBACK");
      } catch (rollbackErr) {
        releaseError = rollbackErr as Error;
      }
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
  // Claim connection already released. At most `limit` jobs, so their nested pool.connect() calls (a
  // create_project handler opens ~3: its own client + ensurePublicPhotoLinkForDeal's client +
  // resolveFallbackAdminUser's pool.query) stay under the pool max. processJob persists each job's
  // outcome via attemptRecovery, which self-registers into pendingRecoveries if the write fails — so it
  // never rejects. allSettled is a defensive backstop: if processJob somehow throws (a bug), it can't
  // reject the poller (index.ts runs the pollers via bare setInterval → unhandled rejection) or clear the
  // reentrancy guard while sibling jobs are still running.
  const settled = await Promise.allSettled(claimed.map((job) => processJob(job)));
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    if (outcome.status === "rejected") {
      const job = claimed[i];
      console.error(`[Worker] Job ${job.id} (${job.job_type}) processing threw unexpectedly:`, outcome.reason);
    }
  }
}

export async function pollJobs() {
  // Reentrancy guard — skip if a previous poll is still running
  if (polling) return;
  polling = true;
  try {
    // Retry any stranded-job recoveries a previous tick couldn't persist (pool was exhausted) so the worker
    // self-heals without a restart. Only the MAIN poller flushes: the dedicated poller's failed outcome
    // writes also land in the shared pendingRecoveries map and are replayed here (a single flusher avoids two
    // loops racing the same intents).
    await flushPendingRecoveries();
    await claimAndRunJobs(MAIN_POLL_JOB_TYPE_SQL, RUN_CONCURRENCY);
  } finally {
    polling = false;
  }
}

// Dedicated poller for the long-running bid_board_ingest import. Its OWN reentrancy guard means a multi-minute
// import blocks ONLY this loop; pollJobs keeps claiming every other job type meanwhile.
let pollingBidBoardIngest = false;
export async function pollBidBoardIngestJobs() {
  if (pollingBidBoardIngest) return;
  pollingBidBoardIngest = true;
  try {
    await claimAndRunJobs(BID_BOARD_INGEST_JOB_TYPE_SQL, BID_BOARD_INGEST_CONCURRENCY);
  } finally {
    pollingBidBoardIngest = false;
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
