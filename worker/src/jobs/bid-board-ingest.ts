// worker/src/jobs/bid-board-ingest.ts
// Handles the 'bid_board_ingest' job type: runs the (unchanged) Bid Board importer asynchronously, one
// office at a time, and records the outcome in the durable inbox. The route only ACCEPTS + enqueues; this
// is where the actual import happens, decoupled from the HTTP request so a slow import can't produce a
// false upstream 502 (incident 2026-07-19).

import type { PoolClient } from "pg";
import { pool } from "../db.js";

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
  }) => Promise<"succeeded" | "noop">;
  recoverOrphanedInboxJobs: (
    db: { query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }> },
    opts?: { staleProcessingMinutes?: number }
  ) => Promise<number>;
}

interface ServiceModule {
  ingestBidBoardRows: (payload: any) => Promise<{ runId: string | null; metrics: unknown; warnings: string[] }>;
}

// Bound how long a waiter blocks on the per-office lock. The worker pool sets no statement/lock timeout,
// so without this a job whose same-office predecessor WEDGED (connection alive, not crashed) would block
// forever and hold a pool connection. On timeout the acquire errors → the job retries with backoff. Set
// comfortably above a normal import (bounded by the server pool's 45s query_timeout).
const OFFICE_LOCK_TIMEOUT = "60s";

/**
 * Serialize per office with a Postgres SESSION advisory lock held across the whole import (the importer
 * opens its own connection/transaction, so a transaction-scoped lock wouldn't span it). Blocks until the
 * lock is free OR lock_timeout elapses — a same-office import in flight simply waits its turn instead of
 * contending on deal rows. The lock is explicitly released; if the unlock query fails the connection is
 * DESTROYED (pg-pool's release(err) removes it from the pool), so a leaked session lock can't be handed to
 * the next borrower.
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
    await client.query(`SET lock_timeout = '${OFFICE_LOCK_TIMEOUT}'`);
    await client.query("SELECT pg_advisory_lock($1, $2)", [namespace, key]);
  } catch (err) {
    // Never acquired the lock (or it timed out). Reset the session setting so the next borrower of this
    // pooled connection doesn't inherit our lock_timeout; if the reset fails, DESTROY the connection.
    let resetErr: Error | undefined;
    try {
      await client.query("RESET lock_timeout");
    } catch (e) {
      resetErr = e instanceof Error ? e : new Error(String(e));
    }
    client.release(resetErr);
    throw err instanceof Error ? err : new Error(String(err));
  }
  let releaseErr: Error | undefined;
  try {
    return await fn();
  } finally {
    // Release the lock AND reset our session-scoped lock_timeout before returning the connection. Any
    // failure here → release(err) destroys the connection, so neither the advisory lock nor the lingering
    // lock_timeout can be handed to the next borrower.
    try {
      await client.query("SELECT pg_advisory_unlock($1, $2)", [namespace, key]);
      await client.query("RESET lock_timeout");
    } catch (err) {
      releaseErr = err instanceof Error ? err : new Error(String(err));
    }
    client.release(releaseErr);
  }
}

export async function handleBidBoardIngestJob(
  payload: { inboxId?: string } | null,
  _officeId: string | null
): Promise<void> {
  const inboxId = payload?.inboxId;
  if (!inboxId) {
    // Malformed job with no inbox id — nothing durable to process. Complete without retry.
    console.warn("[Worker:bid_board_ingest] Job missing inboxId — skipping");
    return;
  }

  const [inbox, service] = await Promise.all([
    importFirstAvailable<InboxModule>(SERVER_INBOX_MODULES),
    importFirstAvailable<ServiceModule>(SERVER_SERVICE_MODULES),
  ]);

  await inbox.processBidBoardInboxJob({
    db: pool,
    inboxId,
    ingest: (p) => service.ingestBidBoardRows(p),
    withOfficeLock: (officeSlug, fn) =>
      withOfficeSessionLock(inbox.BID_BOARD_ADVISORY_NAMESPACE, officeSlug, inbox.officeAdvisoryKey, fn),
    log: (line) => console.log(line),
  });
}

/**
 * Startup + periodic recovery: re-enqueue durable jobs for inbox rows left 'queued' (job insert never
 * landed) or stale 'processing' (worker died mid-import) with no live job. Never throws — recovery must
 * not crash worker boot.
 */
export async function runBidBoardIngestInboxRecovery(): Promise<number> {
  try {
    const inbox = await importFirstAvailable<InboxModule>(SERVER_INBOX_MODULES);
    const recovered = await inbox.recoverOrphanedInboxJobs(pool);
    if (recovered > 0) {
      console.log(`[Worker:bid_board_ingest] Recovered ${recovered} orphaned inbox job(s)`);
    }
    return recovered;
  } catch (err) {
    console.error("[Worker:bid_board_ingest] Inbox recovery failed:", err);
    return 0;
  }
}
