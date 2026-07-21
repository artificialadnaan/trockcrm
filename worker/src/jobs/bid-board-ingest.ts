// worker/src/jobs/bid-board-ingest.ts
// Handles the 'bid_board_ingest' job type: runs the (unchanged) Bid Board importer asynchronously, one
// office at a time, and records the outcome in the durable inbox. The route only ACCEPTS + enqueues; this
// is where the actual import happens, decoupled from the HTTP request so a slow import can't produce a
// false upstream 502 (incident 2026-07-19).

import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { deferJob, type JobHandlerResult } from "../queue.js";

// The importer + inbox state machine live in the server workspace; load them the same dist→src way the
// Procore worker jobs do (compiled dist in prod, src under tsx in dev/test).
const SERVER_INBOX_MODULES = [
  "../../../server/dist/modules/bid-board-sync/inbox.js",
  "../../../server/src/modules/bid-board-sync/inbox.js",
] as const;
const SERVER_SERVICE_MODULES = [
  "../../../server/dist/modules/bid-board-sync/service.js",
  "../../../server/src/modules/bid-board-sync/service.js",
] as const;

async function importFirstAvailable<T>(paths: readonly string[]): Promise<T> {
  let lastError: unknown;
  for (const path of paths) {
    try {
      return (await import(path)) as T;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Unable to import Bid Board sync module");
}

interface InboxModule {
  BID_BOARD_ADVISORY_NAMESPACE: number;
  officeAdvisoryKey: (officeSlug: string) => number;
  processBidBoardInboxJob: (deps: {
    db: { query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }> };
    inboxId: string;
    ingest: (payload: any) => Promise<{ runId: string | null; metrics: unknown; warnings: string[] }>;
    withOfficeLock: <T>(officeSlug: string, fn: () => Promise<T>) => Promise<T>;
    log?: (line: string) => void;
  }) => Promise<"succeeded" | "noop" | { status: "deferred"; runAfterSeconds: number; reason: string }>;
  recoverOrphanedInboxJobs: (
    db: { query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }> },
    opts?: { staleProcessingMinutes?: number; staleJobMinutes?: number; retentionDays?: number }
  ) => Promise<number>;
}

interface ServiceModule {
  ingestBidBoardRows: (payload: any) => Promise<{ runId: string | null; metrics: unknown; warnings: string[] }>;
}

// Bound how long a waiter blocks on the per-office lock. The worker pool sets no statement/lock timeout,
// so without this a job whose same-office predecessor WEDGED (connection alive, not crashed) would block
// forever and hold a pool connection. On timeout the acquire errors → the job retries with backoff. Set
// comfortably above a normal import (bounded by the server pool's 45s query_timeout).
// A same-office import can legitimately hold the lock for MINUTES (ingestBidBoardRows issues several
// queries per row, each bounded by the server pool's 45s query_timeout — the whole import is not). Give a
// waiter a generous window so it waits for the running import rather than timing out and spending an
// attempt. (Same-office concurrency is itself rare: SyncHub serializes scrapes via bidboardStageSyncRunning
// and identical retries are deduped to one job, so the lock mostly never contends.)
const OFFICE_LOCK_TIMEOUT = "300s";
// Client-side timeouts (dead-socket safety — the worker pool sets no query_timeout/keepalive, so without
// these a silent dead socket hangs the query forever, wedging pollJobs()'s reentrancy guard and stopping
// ALL job processing). Acquire is bounded just ABOVE the server-side lock_timeout so that fires first on a
// live connection; other queries are quick so a short bound is plenty.
const LOCK_ACQUIRE_TIMEOUT_MS = 330_000;
const LOCK_CLEANUP_TIMEOUT_MS = 10_000;
const INBOX_QUERY_TIMEOUT_MS = 30_000;

/** Race a query against a client-side timeout so a dead socket can't hang the caller forever. On timeout
 *  the query rejects; the caller destroys the connection (release(err)), which cancels the server-side work. */
async function queryWithTimeout(
  client: PoolClient,
  sql: string,
  params: any[] | undefined,
  ms: number
): Promise<unknown> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`lock query timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([client.query(sql, params), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Serialize per office with a Postgres SESSION advisory lock held across the whole import (the importer
 * opens its own connection/transaction, so a transaction-scoped lock wouldn't span it). Blocks until the
 * lock is free OR lock_timeout elapses — a same-office import in flight simply waits its turn instead of
 * contending on deal rows. Every lock-client query is client-side time-bounded (dead-socket safety), and
 * the lock is explicitly released; if the unlock/reset fails (or times out) the connection is DESTROYED
 * (pg-pool's release(err) removes it from the pool), so neither a leaked session lock nor the lingering
 * lock_timeout can be handed to the next borrower.
 */
async function withOfficeSessionLock<T>(
  namespace: number,
  officeSlug: string,
  keyOf: (slug: string) => number,
  fn: () => Promise<T>
): Promise<T> {
  const key = keyOf(officeSlug);
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
  try {
    await queryWithTimeout(client, `SET lock_timeout = '${OFFICE_LOCK_TIMEOUT}'`, undefined, LOCK_CLEANUP_TIMEOUT_MS);
    await queryWithTimeout(client, "SELECT pg_advisory_lock($1, $2)", [namespace, key], LOCK_ACQUIRE_TIMEOUT_MS);
  } catch (err) {
    // Never acquired the lock (timed out server- or client-side). A client-side timeout means the socket may
    // be dead / the acquire may still be pending, so DESTROY the connection rather than returning it.
    client.release(err instanceof Error ? err : new Error(String(err)));
    throw err instanceof Error ? err : new Error(String(err));
  }
  let releaseErr: Error | undefined;
  try {
    return await fn();
  } finally {
    // Release the lock AND reset our session-scoped lock_timeout before returning the connection. Any
    // failure/timeout here → release(err) destroys the connection, so neither the advisory lock nor the
    // lingering lock_timeout can be handed to the next borrower (and a dead socket can't wedge the poller).
    try {
      await queryWithTimeout(client, "SELECT pg_advisory_unlock($1, $2)", [namespace, key], LOCK_CLEANUP_TIMEOUT_MS);
      await queryWithTimeout(client, "RESET lock_timeout", undefined, LOCK_CLEANUP_TIMEOUT_MS);
    } catch (err) {
      releaseErr = err instanceof Error ? err : new Error(String(err));
    }
    client.release(releaseErr);
  }
}

/** Pool query with a client-side timeout (dead-socket safety). Checks out an EXPLICIT client so a timed-out
 *  query can be DESTROYED (release(err) removes it from the pool). Racing the convenience pool.query() against
 *  a timer would only reject the caller while pool.query keeps its checked-out client — on a genuinely dead
 *  socket that slot never returns, and across retries the leaked slots exhaust the pool until ALL job
 *  processing stops (the exact failure this guard exists to prevent). Mirrors withOfficeSessionLock. */
export async function timedPoolQuery(text: string, params?: any[]): Promise<{ rows: any[]; rowCount?: number | null }> {
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`inbox query timed out after ${INBOX_QUERY_TIMEOUT_MS}ms`));
    }, INBOX_QUERY_TIMEOUT_MS);
  });
  try {
    return (await Promise.race([client.query(text, params), timeout])) as { rows: any[]; rowCount?: number | null };
  } finally {
    clearTimeout(timer);
    // On a client-side timeout the socket may be dead or the query still pending → DESTROY the connection so
    // its slot can't leak. A clean result (or an ordinary query error) returns the connection normally.
    client.release(timedOut ? new Error(`inbox query timed out after ${INBOX_QUERY_TIMEOUT_MS}ms`) : undefined);
  }
}

export async function handleBidBoardIngestJob(
  payload: { inboxId?: string } | null,
  _officeId: string | null
): Promise<JobHandlerResult> {
  const inboxId = payload?.inboxId;
  if (!inboxId) {
    // Malformed job with no inbox id — nothing durable to process. Complete without retry.
    console.warn("[Worker:bid_board_ingest] Job missing inboxId — skipping");
    return;
  }

  // Load ONLY the inbox module here — it's needed to CLAIM the row. Defer the heavier service module (the
  // importer) into the ingest callback, which processBidBoardInboxJob runs AFTER markInboxProcessing has
  // charged an attempt. Otherwise a service-module load failure (missing prod artifact / dep failure) would
  // throw BEFORE the claim, leaving the inbox 'queued' with attempts=0 — and periodic recovery, seeing no
  // live job and an untouched retry budget, would re-enqueue another 5-attempt job forever (infinite loop,
  // never terminal, status stuck 'queued'). Charging the attempt first lets a persistent loader failure
  // dead-letter the inbox like any other repeated failure. (Node caches the import, so the deferred load is
  // a one-time cost.)
  const inbox = await importFirstAvailable<InboxModule>(SERVER_INBOX_MODULES);

  const outcome = await inbox.processBidBoardInboxJob({
    // Time-bound the inbox state-machine queries too (not just the lock-client): a silent dead socket on
    // the timeout-less worker pool would otherwise hang the handler inside markInboxProcessing / the
    // success/failure write, wedging pollJobs() the same way.
    db: { query: timedPoolQuery },
    inboxId,
    ingest: async (p) => {
      const service = await importFirstAvailable<ServiceModule>(SERVER_SERVICE_MODULES);
      return service.ingestBidBoardRows(p);
    },
    withOfficeLock: (officeSlug, fn) =>
      withOfficeSessionLock(inbox.BID_BOARD_ADVISORY_NAMESPACE, officeSlug, inbox.officeAdvisoryKey, fn),
    log: (line) => console.log(line),
  });

  // A live-leased inbox row → DEFER the queue job (don't complete): another handler owns the import, so come
  // back after its lease would lapse to re-drive the inbox promptly if that owner died. "succeeded"/"noop"
  // fall through to a normal completion.
  if (typeof outcome === "object" && outcome.status === "deferred") {
    return deferJob(outcome.reason, outcome.runAfterSeconds);
  }
}

/**
 * Startup + periodic recovery: re-enqueue durable jobs for inbox rows left 'queued' (job insert never
 * landed) or stale 'processing' (worker died mid-import) with no live job. Never throws — recovery must
 * not crash worker boot.
 */
export async function runBidBoardIngestInboxRecovery(): Promise<number> {
  try {
    const inbox = await importFirstAvailable<InboxModule>(SERVER_INBOX_MODULES);
    // Route recovery's queries through the SAME bounded, client-destroying wrapper as the job handler — NOT
    // the raw pool. The worker pool sets no query_timeout, so a silently-dead socket would otherwise hang one
    // of recovery's queries forever: the startup call awaited in worker/src/index.ts would never reach job
    // polling, and periodic invocations could retain pool slots. timedPoolQuery destroys the connection on
    // timeout so a dead socket can neither wedge boot nor leak a slot.
    const recovered = await inbox.recoverOrphanedInboxJobs({ query: timedPoolQuery });
    if (recovered > 0) {
      console.log(`[Worker:bid_board_ingest] Recovered ${recovered} orphaned inbox job(s)`);
    }
    return recovered;
  } catch (err) {
    console.error("[Worker:bid_board_ingest] Inbox recovery failed:", err);
    return 0;
  }
}
