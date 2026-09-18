import type { PoolClient } from "pg";
import { pool } from "./db.js";
import { timedPoolClientQuery, type TimedPoolLike } from "./lib/timed-pool-query.js";

// How many jobs a single poll tick claims AND runs. Concurrency is bounded by the claim count itself
// (we claim exactly this many and run them all at once), so it doubles as the run-phase cap. Handlers
// open nested pooled connections, so this must stay comfortably under the DB pool max (db.ts: max 10) —
// at ~3 connections per create_project handler, 3 keeps a batch within the pool. Claiming only what we
// immediately run avoids marking extra rows 'processing' that then sit un-started behind a slow handler —
// those carry no lease renewal (nothing is running them), so they would be invisible to every poller until
// the expiry sweep noticed them a lease later.
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

/**
 * What the queue can tell a handler about THIS delivery.
 *
 * Optional third argument, so the 40-odd existing handlers are unaffected. It exists for handlers that own
 * state outside job_queue: when a throw dead-letters the final attempt, the queue row is resolved but that
 * external state is not, and only the handler knows how to reconcile it.
 */
export type JobAttemptContext = {
  /** 1-based attempt number for this delivery. */
  attempt: number;
  maxAttempts: number;
  /** True when a throw from this delivery will dead-letter the row rather than schedule another retry. */
  isFinalAttempt: boolean;
};

type JobHandler = (
  payload: any,
  officeId: string | null,
  /**
   * Test-only dependency-injection slot that a dozen handlers already declare. The queue never supplies it,
   * but it occupies the third position, which is why the attempt context comes fourth.
   */
  deps?: any,
  ctx?: JobAttemptContext,
) => Promise<JobHandlerResult>;

const jobHandlers = new Map<string, JobHandler>();

export function registerJobHandler(jobType: string, handler: JobHandler) {
  jobHandlers.set(jobType, handler);
}

/**
 * Every job type currently registered. Exists so an invariant test can check a hand-maintained list
 * against the REAL registry rather than against a grep — see
 * worker/tests/jobs/rfp-round-scoped-jobs.invariant.test.ts, which asserts that every registered
 * `rfp_*` job is classified in RFP_ROUND_SCOPED_JOB_TYPES. Read-only view; the map itself stays private.
 */
export function listRegisteredJobTypes(): string[] {
  return [...jobHandlers.keys()];
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
  | { status: "pending"; error: string; runAfterSeconds: number }
  // A DEFERRAL: the handler chose to hand the work back untouched because another durable lease still owns it
  // (e.g. a live bid_board_ingest import on another replica, or an active recipient lease). Unlike a
  // retry-after-failure 'pending', a deferral must NOT consume a queue attempt — otherwise repeated deferrals of
  // a genuinely-leased job (e.g. startup recovery requeuing an import still running elsewhere) burn the whole
  // attempt budget and dead-letter the queue row without the handler ever executing. So the outcome write rolls
  // the claim's attempt increment BACK, keeping the queue attempt counter aligned with the inbox's (which a
  // deferral also leaves unbumped).
  | { status: "deferred"; error: string; runAfterSeconds: number };

// A deferred outcome write bound to the SPECIFIC claimed attempt it belongs to (`attempts` = the row's
// value at claim time). The write guard checks this so a stale intent flushed late can't apply to a LATER
// claim of the same row (a re-claim increments attempts).
type RecoveryIntent = { attempts: number; outcome: Outcome };

// Outcomes whose write failed (pool still exhausted). Kept here and retried at the start of each poll tick
// so the worker SELF-HEALS once the pool recovers. Not made redundant by the lease sweep below: the sweep
// requeues, which RE-RUNS the handler, whereas these intents replay the outcome the handler already
// earned — a succeeded job recovered as 'completed' rather than run a second time — and they do it on the
// next tick rather than after a lease's worth of waiting. Keyed by job id → the exact intent to replay.
const pendingRecoveries = new Map<number, RecoveryIntent>();

// ── Whose intent is it? ─────────────────────────────────────────────────────────────────────────────
//
// The map is keyed by JOB ID, but an intent belongs to one ATTEMPT — and two attempts of one row genuinely
// overlap. That is an ordinary consequence of the claim being a LEASE (the block below): a handler that is
// slow rather than dead — its renewals failing under pool pressure, its process paused — lets the lease
// lapse, the sweep requeues the row, and another worker claims it. For a while the older attempt is still
// inside its own outcome write while the newer one runs, finishes, and stores ITS intent under the same key.
//
// So every touch of this map asks whose entry it is first. Without that the older attempt silently discards
// the newer attempt's only record of an outcome that already happened — by DELETING it (its own guarded write
// matched nothing, but a delete keyed on job id alone cannot know that) or by OVERWRITING it with its own.
// The consequence is the same either way, and it is not a lost log line: the row stays 'processing' with
// nobody renewing it, no poller selects that status, so it waits out a full lease before the sweep requeues
// it and the handler RE-RUNS work that was already done — a second billed transcription of one walkthrough.
//
// `attempts` is the ownership token here exactly as it is in every guarded statement in this file.

/** Does the map still hold the intent THIS attempt stored — rather than a newer attempt's? */
function ownsPendingRecovery(jobId: number, attempts: number): boolean {
  return pendingRecoveries.get(jobId)?.attempts === attempts;
}

/** May THIS attempt store an intent, or would it evict a newer claim's? A held intent proves a later claim
 *  exists, and a re-claim only moves attempts forward, so a lower-numbered intent could never match again. */
function mayStorePendingRecovery(jobId: number, attempts: number): boolean {
  const held = pendingRecoveries.get(jobId);
  return held === undefined || attempts >= held.attempts;
}

// Did a guarded UPDATE actually land? pg reports the matched-row count on an UPDATE without RETURNING, and
// zero means this attempt no longer owns the row — nothing was written, however cleanly the query returned.
//
// ABSENT is not zero. `rowCount` is pg's field specifically: the unit suite's fakes return bare `{ rows }`,
// and PGlite (the real-SQL suites) reports the same number under `affectedRows`. Reading "no count" as
// "matched nothing" would quietly stop intents ever being retired on either. So this is the narrow "my own
// write demonstrably did not land" signal, and the ownership checks above — which need no driver support at
// all — are what actually protect another attempt's intent.
function guardedWriteMatched(result: { rowCount?: number | null }): boolean {
  return result.rowCount !== 0;
}

// ── The claim is a LEASE ────────────────────────────────────────────────────────────────────────────
//
// A claim marks a row 'processing', and NOTHING selects that status: every poller takes 'pending' rows
// only. So a claim whose owner dies is not a delayed job, it is a job that stops existing as work — no
// dead letter, no alert, no retry. Startup recovery is not a general answer to that, because it runs once
// and only sees rows already five minutes stale: a worker that crashes 30 seconds into a forward and
// restarts leaves that row behind permanently.
//
// The fix that does NOT work is running the same age-based sweep on a timer. `started_processing_at` alone
// means "when this delivery began", so age cannot separate a worker that died two minutes ago from a
// forward three minutes into a legitimate multi-GB upload — and reclaiming the latter hands one walk to two
// workers, which is the duplicate (billed) transcription + scope extraction the glasses seam is built
// around avoiding. So the timestamp is turned into a LEASE: the claim stamps it, and `renewJobLease` below
// re-stamps it for as long as the handler is running. Age then means "how long since this row's owner last
// proved it was alive", which only a dead owner's rows accumulate.
//
// This is the same shape as the inbox lease this codebase already runs one layer down
// (INBOX_LEASE_RENEW_MS / INBOX_LEASE_TTL_SECONDS, server/src/modules/bid-board-sync/inbox.ts), and the
// margin is deliberately as generous: five missed renewals before a lease expires, so a GC pause, a slow
// tick, or a couple of failed writes cannot falsely expire a live one. That module also carries a
// bid_board_ingest-ONLY version of the sweep below (step (0) of runBidBoardIngestInboxRecovery, whose own
// comment names the gap: "recoverStaleJobs() only runs at worker startup; this periodic sweep covers a
// crash-without-restart window"), lease-aware only because it can consult the INBOX's lease. Every other
// job type had no such second mechanism, and none should need one — which is why this belongs here rather
// than being written a third time for glasses walkthroughs.
const JOB_LEASE_EXPIRY_SECONDS = 300;
let JOB_LEASE_RENEW_MS = 60_000;

/** Test-only: shrink the renewal interval so lease behaviour can be exercised in milliseconds. */
export function __setJobLeaseRenewIntervalForTest(ms: number) {
  JOB_LEASE_RENEW_MS = ms;
}

// How often the expired-lease sweep runs. Its own cadence, not the poll interval: it is a predicate over
// the whole table and the rows it exists for appear only when a worker dies, so running it on every tick
// would be several full-table UPDATEs a minute to find nothing. Recovery latency is bounded by the lease
// expiry regardless, so a faster sweep buys nothing.
const JOB_LEASE_SWEEP_INTERVAL_MS = 60_000;
let lastJobLeaseSweepAt = 0;
// The sweep in flight, if any. Tracked rather than awaited by the tick that started it — see
// startExpiredJobLeaseSweepIfDue for why, and so a second tick can't start a second sweep over the same rows.
let jobLeaseSweep: Promise<void> | null = null;

/** Test-only: settle on the in-flight sweep. Only tests need this — a poll tick deliberately does not wait. */
export function __awaitJobLeaseSweepForTest(): Promise<void> {
  return jobLeaseSweep ?? Promise.resolve();
}

/** Test-only: make the sweep due on the next poll tick (it is throttled by default after a reset). */
export function __setJobLeaseSweepDueForTest() {
  lastJobLeaseSweepAt = 0;
}

/**
 * Test-only: reset module singleton state between cases.
 *
 * The reentrancy guards belong here as much as pendingRecoveries does, and are declared further down —
 * hence the forward references. A guard is set for the whole of a poll and cleared in a `finally`, so it
 * only survives a case that DIDN'T let the poll finish: a vitest timeout, a fake that never settles, an
 * assertion thrown from inside a router. When that happens the guard is stuck `true` for the rest of the
 * FILE, and every later call to that poller returns immediately having done nothing — so the next case
 * fails on an empty `queries` array with no hint that its own poll never ran. All four are reset, not
 * just the one that has an in-flight test today: the failure mode is identical for each, and it presents
 * as a bug in whichever unlucky test runs next.
 */
export function __resetQueueStateForTest() {
  pendingRecoveries.clear();
  // Left THROTTLED, not due. The sweep checks out its OWN pooled client now (it no longer rides the
  // convenience pool.query), so a due sweep adds a connect/release and a job_queue UPDATE to every tick —
  // and a case asking "was the claim connection released before the handlers ran?" would be answering it
  // over a checkout that belongs to something else entirely. Cases that ARE about the sweep opt in via
  // __setJobLeaseSweepDueForTest, which is also the only honest way to read them.
  lastJobLeaseSweepAt = Date.now();
  // Same hazard one level up: a case that ends while a sweep is still in flight (a fake that never settles,
  // a vitest timeout) would otherwise leave this non-null and make every later case's sweep a silent no-op.
  jobLeaseSweep = null;
  polling = false;
  pollingBidBoardIngest = false;
  pollingAiReport = false;
  pollingGlassesWalkthroughForward = false;
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
    case "deferred":
      // Same as 'pending' but ROLLS BACK the claim's attempt increment (attempts - 1): a deferral is not an
      // attempt. Still guarded on status='processing' AND attempts = the claimed value, so it only rolls back the
      // row THIS handler claimed — never a later re-claim (which bumped attempts again). The row lands back at
      // its pre-claim attempt count so a live-leased job can be re-driven indefinitely without dead-lettering.
      return {
        sql: `UPDATE public.job_queue SET status = 'pending', last_error = $1, run_after = NOW() + make_interval(secs => $2), attempts = attempts - 1 WHERE id = $3 AND status = 'processing' AND attempts = $4`,
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
// Used for the CLAIM path, where the caller already holds an EXPLICIT client it destroys via release(err).
function withQueueTimeout<T>(query: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new QueueQueryTimeout(label)), QUEUE_QUERY_TIMEOUT_MS);
  });
  return Promise.race([query, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

// Time-bounded queue query, on the shared checkout-race-destroy helper (lib/timed-pool-query.ts). Racing the
// convenience pool.query() against a timer instead would only reject the caller while pool.query keeps its
// checked-out client — on a genuinely dead socket that slot never returns, and because the deferred-recovery
// flush re-attempts the write every tick, the leaked slots pile up until they exhaust the pool (max 10) and
// stall UNRELATED worker jobs. `label` names the caller in the timeout error.
//
// Every non-claim statement this module issues goes through here — the outcome writes, the lease renewal
// AND the expiry sweep. The sweep was the last holdout on the convenience query, which was survivable only
// while it ran once at startup; on a periodic tick an unbounded statement is the one that wedges the poller.
// The timeout is read at CALL time, not module-init time, so __setQueueQueryTimeoutForTest still bites.
async function timedQueueQuery(
  sql: string,
  params: any[],
  label: string
): Promise<{ rows: any[]; rowCount?: number | null }> {
  return timedPoolClientQuery(pool as unknown as TimedPoolLike, sql, params, {
    timeoutMs: QUEUE_QUERY_TIMEOUT_MS,
    timeoutError: () => new QueueQueryTimeout(label),
  });
}

/**
 * Re-stamp one claimed row's lease. Guarded exactly like buildOutcomeUpdate — status='processing' AND the
 * attempts value THIS delivery claimed — because a renewal that addresses the row rather than the claim is
 * worse than no renewal at all: a handler whose lease already lapsed, and whose row a sweep requeued and
 * another worker re-claimed, would go on pushing the timestamp forward under the NEW owner. That row's
 * lease could then never expire, so the one dead worker would make it permanently unreclaimable — the
 * original bug, made unrecoverable.
 */
async function renewJobLease(jobId: number, attempts: number): Promise<void> {
  await timedQueueQuery(
    `UPDATE public.job_queue SET started_processing_at = NOW() WHERE id = $1 AND status = 'processing' AND attempts = $2`,
    [jobId, attempts],
    `job ${jobId} lease renewal`
  );
}

/**
 * Hold the lease for the life of one handler invocation; the returned function drops it. Stopping is not
 * optional bookkeeping — a timer that outlives its handler keeps a finished row's lease fresh forever, and
 * no sweep can reclaim a row whose owner is still (uselessly) insisting it is alive.
 *
 * A failed renewal is logged and otherwise ignored. Failing the JOB over it would turn one blip in the pool
 * into a lost delivery, and letting the lease lapse is the recoverable direction: the sweep requeues the
 * row, and every write this attempt can still make is attempt-bound, so it cannot stomp the re-claim.
 */
function startJobLeaseHeartbeat(jobId: number, attempts: number): () => void {
  let renewing = false;
  const timer = setInterval(() => {
    // One renewal in flight at a time. A beat overlaps its predecessor whenever a renewal outlives the
    // interval — on a dead socket timedQueueQuery waits out QUEUE_QUERY_TIMEOUT_MS, which at 30s against a
    // 60s interval leaves production margin today, but the two constants are independent (and the suite runs
    // this at a 20ms interval via __setJobLeaseRenewIntervalForTest, where they invert). Unguarded,
    // overlapping beats would each check out a connection and pile up at exactly the moment the pool is
    // already the thing in trouble.
    if (renewing) return;
    renewing = true;
    void renewJobLease(jobId, attempts)
      .catch((err) => {
        console.warn(`[Worker] Job ${jobId} lease renewal failed; the lease will lapse if this persists:`, err);
      })
      .finally(() => {
        renewing = false;
      });
  }, JOB_LEASE_RENEW_MS);
  // unref so a renewal timer is never the reason the process stays alive (mirrors the inbox heartbeat).
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}

/** Persist a job's outcome (its normal terminal write). On failure, keep the full intent for a later tick —
 *  unless a newer attempt of the same row already owns that slot (see "Whose intent is it?" above). */
async function attemptRecovery(jobId: number, attempts: number, outcome: Outcome): Promise<void> {
  const { sql, params } = buildOutcomeUpdate(jobId, attempts, outcome);
  try {
    // Time-bounded so a dead socket can't hang the run phase (and the reentrancy guard). Checks out an explicit
    // client and DESTROYS it on timeout (see timedQueueQuery) so a hung write can't leak a pool slot — which,
    // re-attempted every tick by the flush, would otherwise exhaust the pool and stall unrelated jobs. A timeout
    // leaves the intent in pendingRecoveries for a later tick, exactly like any other write failure.
    const result = await timedQueueQuery(sql, params, `job ${jobId} outcome write`);
    // Retire an intent only if this write MATCHED and the intent is still THIS attempt's. A guarded write
    // that matched nothing is not a write that happened — the row moved past this attempt while the handler
    // ran — so it resolved nothing and has no standing to retire anything. Deleting on the bare job id here
    // is how a stale attempt used to erase a newer attempt's stored outcome: the query returns cleanly with
    // zero rows affected, and the row it did not write then sits 'processing' with no heartbeat behind it.
    if (guardedWriteMatched(result) && ownsPendingRecovery(jobId, attempts)) pendingRecoveries.delete(jobId);
  } catch (err) {
    // The same collision on the way IN. A superseded attempt storing its own intent evicts the newer one just
    // as completely as deleting it, and what it leaves behind can never match again (a re-claim only moves
    // attempts forward) — a doomed write replayed every tick in place of the outcome that actually happened.
    if (!mayStorePendingRecovery(jobId, attempts)) {
      console.warn(
        `[Worker] Job ${jobId} outcome write ('${outcome.status}') failed on attempt ${attempts}, which a later claim has already superseded; leaving the newer attempt's recovery intent in place:`,
        err
      );
      return;
    }
    pendingRecoveries.set(jobId, { attempts, outcome });
    console.error(`[Worker] Job ${jobId} outcome write ('${outcome.status}') failed; will retry next tick:`, err);
  }
}

/**
 * START a sweep of rows whose lease has expired, at most once per JOB_LEASE_SWEEP_INTERVAL_MS. Returns as
 * soon as it is running, not when it is done — the caller is a poll tick, and no part of a tick depends on
 * the answer.
 *
 * Rides the main poller rather than its own timer in index.ts, for the reason flushPendingRecoveries does:
 * this is shared self-healing for EVERY poller — the dedicated ones (bid_board_ingest, ai_report_generation,
 * glasses_walkthrough_forward) strand rows in exactly the same way and cannot sweep for themselves, since
 * their claim predicates see only their own type and only 'pending'. One sweeper for all of them beats
 * three loops racing the same rows.
 */
function startExpiredJobLeaseSweepIfDue(): void {
  // Never two at once. The throttle below almost always covers this, but "almost" is the wrong word for a
  // full-table UPDATE: a sweep that runs long enough to outlive its own interval would otherwise get a
  // second copy racing it over the same rows, each holding a connection.
  if (jobLeaseSweep) return;
  const now = Date.now();
  if (now - lastJobLeaseSweepAt < JOB_LEASE_SWEEP_INTERVAL_MS) return;
  lastJobLeaseSweepAt = now;
  // Started BESIDE the tick, not inside it. Nothing in a poll tick reads this sweep's result — it requeues
  // rows that the NEXT tick's claim will pick up either way — so making the tick wait on it only exports the
  // sweep's worst case onto the claim path. That worst case is a statement blocked on a row lock or a
  // half-dead socket, i.e. exactly when the poller most needs to keep claiming; a self-healing mechanism
  // must not be able to stall the thing it heals. The statement is bounded (timedQueueQuery) so the promise
  // always settles, and the throttle stamp above is taken before it starts, so a slow sweep delays the next
  // sweep rather than piling up.
  jobLeaseSweep = recoverStaleJobs()
    .catch((err) => {
      // Swallowed, and it MUST be: nothing awaits this promise in production, so an escaping rejection is an
      // unhandled rejection that takes the worker down — and this statement is exactly what fails when the
      // pool is exhausted, i.e. when the worker is already having a bad minute.
      console.error("[Worker] Expired-lease sweep failed; retrying on a later tick:", err);
    })
    .finally(() => {
      jobLeaseSweep = null;
    });
}

/** Retry any outcome writes a prior tick couldn't persist. Stops at the first failure (pool still down). */
async function flushPendingRecoveries(): Promise<void> {
  for (const [jobId, { attempts, outcome }] of [...pendingRecoveries]) {
    const { sql, params } = buildOutcomeUpdate(jobId, attempts, outcome);
    try {
      await timedQueueQuery(sql, params, `job ${jobId} outcome flush`);
      // Retire the intent this iteration WROTE, not whatever the key holds now. The snapshot above is taken
      // once, but the dedicated pollers keep running deliveries throughout a main-poller tick, so a newer
      // attempt of this same row can store its intent here while this write is in flight — and a delete by
      // job id alone would drop it, exactly as the outcome path could.
      //
      // Deliberately NOT also conditional on the write matching, unlike attemptRecovery: an intent whose
      // guarded write matched nothing can never match again (the row has moved past its attempt), so keeping
      // it would re-issue a doomed UPDATE every tick forever. This is where such an intent is retired.
      if (ownsPendingRecovery(jobId, attempts)) pendingRecoveries.delete(jobId);
    } catch {
      break; // pool still unavailable / dead socket — retry the rest on a later tick
    }
  }
}

// The main poller EXCLUDES the long-running job types; each gets its own dedicated poller so a multi-minute
// run can't hold a shared reentrancy guard across its run phase and starve the email / domain-event /
// delivery jobs the main poller would otherwise claim on later ticks.
//   • bid_board_ingest    — a Procore import, runs for MINUTES (pollBidBoardIngestJobs)
//   • ai_report_generation — a Claude vision pass over up to 60 photographs; 30-90s typically and minutes in
//     the worst case (3 retries x a 10-minute per-attempt timeout), so it belongs here for exactly the same
//     reason (pollAiReportJobs)
//   • glasses_walkthrough_forward — relays a glasses walkthrough's clips (video/audio/photo, potentially
//     GIGABYTES) to TROCK Scope via ranged R2 reads + multipart upload; one can hold the guard for minutes,
//     so it gets the same dedicated treatment (pollGlassesWalkthroughForwardJobs)
//   • weekly_report_send  — renders the client PDF before it can send: `resolveWeeklyReportPdfKeyViaServer`
//     downloads and transcodes EVERY photo on the report and uploads the result to R2, which is the same
//     shape of work as ai_report_generation and belongs under the same rule (pollWeeklyReportSendJobs)
const MAIN_POLL_JOB_TYPE_SQL =
  "AND job_type NOT IN ('bid_board_ingest', 'ai_report_generation', 'glasses_walkthrough_forward', 'weekly_report_send')";
const BID_BOARD_INGEST_JOB_TYPE_SQL = "AND job_type = 'bid_board_ingest'";
const AI_REPORT_JOB_TYPE_SQL = "AND job_type = 'ai_report_generation'";
const GLASSES_WALKTHROUGH_FORWARD_JOB_TYPE_SQL = "AND job_type = 'glasses_walkthrough_forward'";
const WEEKLY_REPORT_SEND_JOB_TYPE_SQL = "AND job_type = 'weekly_report_send'";
// One import at a time on the dedicated poller: imports are already per-office-serialized by an advisory lock,
// and each holds a lock connection + the importer's queries, so a single in-flight import keeps this poller
// well under the DB pool max even while the main poller runs its own RUN_CONCURRENCY batch.
const BID_BOARD_INGEST_CONCURRENCY = 1;
// One report at a time: each run holds tens of MB of decoded image data plus its own short transactions, so
// running several concurrently is the straightforward way to OOM the worker. Reports are not latency-critical
// (the phone polls and shows progress), so serializing them is the right trade.
const AI_REPORT_CONCURRENCY = 1;
// One client report at a time, for the reason directly above: a send renders the report's PDF first, which
// decodes every photo on it into memory and uploads to R2. Three of those on the main poller's shared slots
// is both the OOM shape ai_report_generation is serialized to avoid AND a starvation shape — the main poller
// also carries RFP delivery and email sync, and a Monday morning sends many reports at once. Sends are not
// latency-critical: the CRM shows "Sending…" and the board reconciles, so serializing them is the right trade.
const WEEKLY_REPORT_SEND_CONCURRENCY = 1;
// One forward at a time, same "one long-running unit at a time" posture as the two pollers above: each run
// relays every clip of a walk (potentially gigabytes) over the estimator's real-world network conditions, so
// running several concurrently would let one dedicated poller tick spend minutes of bandwidth/wall-clock on
// several multi-GB uploads at once for no latency benefit — nothing here is interactive.
const GLASSES_WALKTHROUGH_FORWARD_CONCURRENCY = 1;

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
    // Requeue rows whose owner died mid-delivery. Here rather than at startup only, and safe there only
    // because a live delivery renews its lease — see the LEASE block above. Deliberately NOT awaited: the
    // claim below must not inherit this statement's worst case (see startExpiredJobLeaseSweepIfDue).
    startExpiredJobLeaseSweepIfDue();
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

// Dedicated poller for the AI photo report, for the same reason as bid_board_ingest: a Claude vision pass
// over 60 photographs holds this loop for its whole run, and it must not be the main loop.
let pollingAiReport = false;
export async function pollAiReportJobs() {
  if (pollingAiReport) return;
  pollingAiReport = true;
  try {
    await claimAndRunJobs(AI_REPORT_JOB_TYPE_SQL, AI_REPORT_CONCURRENCY);
  } finally {
    pollingAiReport = false;
  }
}

// Dedicated poller for the client weekly-report send, same reason as the AI report above: the PDF render it
// performs first holds tens of MB of decoded image data and can run for a while on a photo-heavy report.
let pollingWeeklyReportSend = false;
export async function pollWeeklyReportSendJobs() {
  if (pollingWeeklyReportSend) return;
  pollingWeeklyReportSend = true;
  try {
    await claimAndRunJobs(WEEKLY_REPORT_SEND_JOB_TYPE_SQL, WEEKLY_REPORT_SEND_CONCURRENCY);
  } finally {
    pollingWeeklyReportSend = false;
  }
}

// Dedicated poller for the glasses-walkthrough forward, for the same reason as the two above: relaying a
// walk's clips to TROCK Scope over ranged R2 reads can hold this loop for minutes, and it must not be the
// main loop (which would otherwise stall email/domain-event/delivery jobs behind a multi-GB video).
let pollingGlassesWalkthroughForward = false;
export async function pollGlassesWalkthroughForwardJobs() {
  if (pollingGlassesWalkthroughForward) return;
  pollingGlassesWalkthroughForward = true;
  try {
    await claimAndRunJobs(GLASSES_WALKTHROUGH_FORWARD_JOB_TYPE_SQL, GLASSES_WALKTHROUGH_FORWARD_CONCURRENCY);
  } finally {
    pollingGlassesWalkthroughForward = false;
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
  // The claim stamped this row's lease; hold it for exactly as long as the handler owns the row. Dropped in
  // the finally below — including on a throw — so a genuinely dead delivery's lease can lapse and the sweep
  // can reclaim it, which is the whole point of renewing it in the first place.
  const releaseJobLease = startJobLeaseHeartbeat(job.id, claimedAttempt);
  let outcome: Outcome;
  try {
    const result = await handler(job.payload, job.office_id, undefined, {
      attempt: claimedAttempt,
      maxAttempts: job.max_attempts,
      isFinalAttempt: claimedAttempt >= job.max_attempts,
    });
    if (result && result.status === "dead") {
      outcome = { status: "dead", error: result.error };
      console.error(`[Worker] Job ${job.id} (${job.job_type}) rejected without retry: ${result.error}`);
    } else if (result && result.status === "pending") {
      // A handler-RETURNED 'pending' is always a deliberate DEFERRAL (a retry-after-failure 'pending' is
      // computed in the catch below from a thrown error, never returned). A deferral must not consume a queue
      // attempt, so it's persisted as the 'deferred' outcome, which rolls the claim's increment back — otherwise
      // repeated deferrals of a genuinely-leased job would burn the attempt budget and dead-letter it unrun.
      outcome = {
        status: "deferred",
        error: result.error,
        runAfterSeconds: Math.max(1, Math.ceil(result.runAfterSeconds)),
      };
      console.log(
        `[Worker] Job ${job.id} (${job.job_type}) deferred for ${outcome.runAfterSeconds}s (attempt not consumed): ${result.error}`,
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
  } finally {
    releaseJobLease();
  }
  // Deliberately AFTER the lease is dropped, not inside it: the outcome write is attempt-bound, so if it
  // fails and the row is later reclaimed, the replay simply matches nothing. Holding the lease until the
  // write lands would instead need the pool to stay broken for a full lease to matter — and the sweep's own
  // statement fails in exactly that case too, so nothing would run anyway.
  await attemptRecovery(job.id, claimedAttempt, outcome);
}

/**
 * Requeue every row whose claim LEASE has expired — a delivery whose owner has not re-stamped
 * `started_processing_at` for JOB_LEASE_EXPIRY_SECONDS, i.e. one whose worker is gone.
 *
 * Runs at startup (awaited, before any poller exists) AND alongside the main poller's throttled tick
 * (startExpiredJobLeaseSweepIfDue, which does NOT await it). Startup alone was
 * never enough: it only sees rows already expired at boot, so a worker that crashed inside the expiry
 * window and came back left its row 'processing' forever, invisible to every poller. What makes the
 * periodic run safe is the renewal — see the LEASE block at the top of this file. Read `started_processing_at`
 * here as "last proof of life", never as "start time"; a live 20-minute forward is as fresh as one that
 * began a second ago.
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
  // Time-bounded on an EXPLICIT client, exactly like the claim, the renewal and the outcome writes — never
  // the pool's convenience `query`. This statement has two ways to never answer: a silently-dead socket
  // (the pool sets no query_timeout, db.ts) and an UPDATE parked behind another transaction's row lock,
  // which is unremarkable on a table every poller writes to. Unbounded, that promise stays PENDING, so the
  // caller's catch never runs — a rejection handler cannot fire on a promise that does not settle — and the
  // one sweeper for every poller becomes the thing that stops them. timedQueueQuery also DESTROYS a timed-
  // out client (release(err)) rather than returning it, so a sweep that runs every minute cannot leak a
  // pool slot a minute until max 10 is gone and unrelated jobs stall behind it.
  const result = await timedQueueQuery(
    `UPDATE public.job_queue
     SET status = 'pending', last_error = 'Recovered from an expired claim lease (its worker stopped renewing it)'
     WHERE status = 'processing'
       AND started_processing_at < NOW() - make_interval(secs => $1)
     RETURNING id, job_type`,
    [JOB_LEASE_EXPIRY_SECONDS],
    "expired-lease sweep"
  );
  if (result.rows.length > 0) {
    console.log(`[Worker] Recovered ${result.rows.length} stale jobs:`,
      result.rows.map((r: any) => `${r.id}:${r.job_type}`).join(", ")
    );
  }
}
