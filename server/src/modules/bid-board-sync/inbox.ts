import crypto from "crypto";

/**
 * Durable, idempotent Bid Board ingestion inbox.
 *
 * Splits the ingest into two phases so a slow import can no longer produce a false upstream 502 or
 * duplicate concurrent imports (incident 2026-07-19):
 *   1. ACCEPT (route, fast): verify HMAC → hash the raw body → UPSERT into bid_board_ingestion_inbox
 *      keyed by (office_slug, payload_hash) → enqueue ONE public.job_queue row carrying only the inbox id
 *      → return 202. Retries / concurrent duplicates of the same payload collapse to one logical job.
 *   2. PROCESS (worker, async, per-office-serialized): run ingestBidBoardRows UNCHANGED and record
 *      queued→processing→succeeded/failed with timings.
 *
 * Every DB function takes a `Querier` ({ query }) so the route can pass a pooled client and the runtime
 * tests can pass a PGlite adapter — the whole state machine is exercised in the CI gate.
 */

export const BID_BOARD_INGEST_JOB_TYPE = "bid_board_ingest";
/** Kept in lockstep with the enqueued job's max_attempts so the inbox's terminal 'failed' write lands on
 *  the SAME attempt the job queue dead-letters. */
export const BID_BOARD_INGEST_MAX_ATTEMPTS = 5;

/** Fixed namespace for pg_advisory_lock(int4, int4); paired with officeAdvisoryKey(slug) to serialize
 *  processing per office. 0x62696462 = "bidb", inside positive int4 range. */
export const BID_BOARD_ADVISORY_NAMESPACE = 0x62696462;

export type InboxStatus = "queued" | "processing" | "succeeded" | "failed";

export interface Querier {
  query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
}

const OFFICE_SLUG_RE = /^[a-z][a-z0-9_]*$/;

export function isValidOfficeSlug(slug: unknown): slug is string {
  return typeof slug === "string" && OFFICE_SLUG_RE.test(slug);
}

/** Extract + validate the office slug from a BidBoardSyncPayload (accepts snake_case or camelCase). */
export function extractOfficeSlug(payload: any): string | null {
  const slug = payload?.office_slug ?? payload?.officeSlug;
  return isValidOfficeSlug(slug) ? slug : null;
}

/**
 * Resolve the office slug for ACCEPT, preserving the importer's LEGACY fallback: a payload that OMITS the
 * office (absent or empty/whitespace) defaults to 'dallas' — mirroring the unchanged
 * `normalizeOfficeSlug` (service.ts), so a signed sender relying on that documented-by-code default keeps
 * ingesting. A PRESENT but schema-unsafe slug is still rejected (returns null): the slug becomes a tenant
 * schema name + advisory-lock key, so a malformed value must never be silently coerced to dallas.
 */
export function resolveIngestOfficeSlug(payload: any): string | null {
  // Mirror the importer's normalizeOfficeSlug EXACTLY: textValue(office_slug) ?? textValue(officeSlug) ??
  // 'dallas', where textValue trims and maps empty/whitespace to null. Coalescing on the RAW aliases
  // (office_slug ?? officeSlug) would let a BLANK office_slug shadow a valid camelCase officeSlug and mis-key
  // the row to dallas while the importer writes the other tenant (overlapping imports; status probes miss it).
  const textValue = (value: unknown): string | null => {
    if (value == null) return null;
    const text = String(value).trim();
    return text.length > 0 ? text : null;
  };
  const slug = textValue(payload?.office_slug) ?? textValue(payload?.officeSlug);
  if (slug == null) return "dallas";
  // The importer accepts any non-empty alias; the ROUTE additionally rejects a schema-unsafe slug (it becomes
  // a tenant schema name + advisory-lock key), so a malformed present value 400s rather than being coerced.
  return isValidOfficeSlug(slug) ? slug : null;
}

/**
 * Row count for the inbox row + processing logs. Prefers the sender's provenance count, else derives it the
 * SAME way the importer's `extractRows` does — top-level `rows`, else flattened `sheets` (array-of-sheets or
 * a keyed object) — so a sheets-form payload records its real size instead of 0 (the observability this
 * incident added would otherwise report zero rows for a large ingestion).
 */
export function countPayloadRows(payload: any): number {
  const provenance = payload?.provenance;
  if (typeof provenance?.rowCount === "number") return provenance.rowCount;
  if (typeof provenance?.row_count === "number") return provenance.row_count;
  if (Array.isArray(payload?.rows)) return payload.rows.length;
  const sheets = payload?.sheets;
  if (Array.isArray(sheets)) {
    return sheets.reduce((n: number, sheet: any) => n + (Array.isArray(sheet?.rows) ? sheet.rows.length : 0), 0);
  }
  if (sheets && typeof sheets === "object") {
    return Object.values(sheets).reduce((n: number, rows: any) => n + (Array.isArray(rows) ? rows.length : 0), 0);
  }
  return 0;
}

/** Stable idempotency key: sha256 of the EXACT request bytes SyncHub signed. A retry of the same POST
 *  carries identical bytes → identical key → one logical ingestion; a genuinely new scrape (new
 *  extractedAt or changed rows) hashes differently → its own job.
 *  CONTRACT: must stay byte-identical with SyncHub's computeBidBoardIdempotencyKey (both hash the exact
 *  serialized body) so a status probe by key resolves the row after an ambiguous 502. */
export function computeIdempotencyKey(rawBody: Buffer | string): string {
  return crypto.createHash("sha256").update(rawBody).digest("hex");
}

/** Deterministic positive int4 hash of the office slug (FNV-1a) for the advisory lock's second key.
 *  Computed in JS (not SQL hashtext()) so the worker's lock and any test agree on the exact integer. */
export function officeAdvisoryKey(officeSlug: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < officeSlug.length; i++) {
    h ^= officeSlug.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h & 0x7fffffff;
}

export interface AcceptResult {
  inboxId: string;
  status: InboxStatus;
  duplicate: boolean;
  idempotencyKey: string;
}

/**
 * Durably accept an ingestion request: UPSERT the inbox row and, only for a genuinely-new row, enqueue one
 * job. Atomic (outbox pattern) so an accepted payload always has a matching job or none. Idempotent via the
 * (office_slug, payload_hash) unique constraint — sequential AND concurrent duplicates return the SAME
 * logical row without enqueuing a second import.
 */
export async function acceptBidBoardIngestion(
  db: Querier,
  args: {
    officeSlug: string;
    payload: unknown;
    payloadHash: string;
    rowCount: number;
    sourceFilename: string | null;
    maxAttempts?: number;
  }
): Promise<AcceptResult> {
  const maxAttempts = args.maxAttempts ?? BID_BOARD_INGEST_MAX_ATTEMPTS;

  const officeRes = await db.query(
    `SELECT id FROM public.offices WHERE slug = $1 AND is_active = true`,
    [args.officeSlug]
  );
  const officeId: string | null = officeRes.rows[0]?.id ?? null;

  // Single-statement outbox: the inbox UPSERT and its ONE job_queue row are inserted ATOMICALLY via
  // data-modifying CTEs (both execute exactly once; the job CTE reads the inbox insert's RETURNING output,
  // so it enqueues iff a new row was actually inserted). No orphan 'queued' row can exist without a job,
  // and no wrapping transaction is needed — so concurrent identical requests stay correct on the
  // (office_slug, payload_hash) UNIQUE constraint: exactly one inserts+enqueues, the rest see a conflict.
  // The 25MB payload lives here; job_queue carries only the inbox id (its poller does SELECT * per tick).
  const insertParams = [
    args.officeSlug,
    officeId,
    args.payloadHash,
    JSON.stringify(args.payload),
    args.rowCount,
    args.sourceFilename,
    maxAttempts,
    BID_BOARD_INGEST_JOB_TYPE,
  ];

  // Loop to close a rare race: the CTE can see the UNIQUE conflict (row exists) while the retention sweep
  // then deletes that expired terminal row before the duplicate lookup — leaving neither an insert nor an
  // existing row. Re-running the CTE once (the conflicting row is now gone) inserts fresh. Bounded so a
  // pathological ping-pong can't spin.
  for (let attempt = 0; attempt < 3; attempt++) {
    const inserted = await db.query(
      `WITH ins AS (
         INSERT INTO public.bid_board_ingestion_inbox
           (office_slug, office_id, payload_hash, payload, row_count, source_filename, status, max_attempts)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, 'queued', $7)
         ON CONFLICT (office_slug, payload_hash) DO NOTHING
         RETURNING id, office_id, max_attempts
       ), job AS (
         INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after, max_attempts)
         SELECT $8::text, jsonb_build_object('inboxId', ins.id::text), ins.office_id, 'pending', NOW(), ins.max_attempts
         FROM ins
         RETURNING 1
       )
       SELECT id FROM ins`,
      insertParams
    );

    if (inserted.rows.length > 0) {
      return { inboxId: inserted.rows[0].id, status: "queued", duplicate: false, idempotencyKey: args.payloadHash };
    }

    // Conflict: a row already exists for (office, hash) WITH its job (insert+enqueue is atomic). Return its
    // current status; do NOT enqueue again.
    const existing = await db.query(
      `SELECT id, status FROM public.bid_board_ingestion_inbox WHERE office_slug = $1 AND payload_hash = $2`,
      [args.officeSlug, args.payloadHash]
    );
    const row = existing.rows[0];
    if (row) {
      return { inboxId: row.id, status: row.status as InboxStatus, duplicate: true, idempotencyKey: args.payloadHash };
    }
    // Row vanished between the conflict and the lookup (retention delete) — retry the insert.
  }

  throw new Error("acceptBidBoardIngestion: could not insert or resolve the inbox row after retries");
}

export interface InboxRow {
  id: string;
  office_slug: string;
  office_id: string | null;
  payload: any;
  payload_hash: string;
  row_count: number;
  source_filename: string | null;
  status: InboxStatus;
  attempts: number;
  max_attempts: number;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  lease_expires_at: string | null;
}

/**
 * Lease/heartbeat for an in-flight import. markInboxProcessing stamps `lease_expires_at = NOW() + TTL`; the
 * worker RENEWS it every INBOX_LEASE_RENEW_MS while the import runs (incl. the office-lock wait). A concurrent
 * claimant can re-claim a 'processing' row ONLY once its lease has EXPIRED (the previous handler died) — never
 * a live long-running import. Without this, the stale-job sweep reclaiming a live >15m import lets a second
 * handler re-run markInboxProcessing and burn another inbox attempt, prematurely dead-lettering a healthy
 * import. TTL is comfortably above the renew interval so a GC pause can't falsely expire a live lease.
 */
export const INBOX_LEASE_TTL_SECONDS = 180;
export const INBOX_LEASE_RENEW_MS = 60_000;

export async function loadInboxRow(db: Querier, inboxId: string): Promise<InboxRow | null> {
  const res = await db.query(`SELECT * FROM public.bid_board_ingestion_inbox WHERE id = $1`, [inboxId]);
  return (res.rows[0] as InboxRow) ?? null;
}

/** Transition a claimable row → processing, stamping the attempt, start time, and a fresh lease.
 *  Claims a 'queued' row always; claims a 'processing' row ONLY if its lease has EXPIRED (its handler died) —
 *  so a live long-running import can't be double-claimed (which would burn an attempt). Returns the updated
 *  row, or null for a TERMINAL row ('succeeded'/'failed') or a still-LEASED 'processing' row — a no-op so a
 *  drifting/reclaimed job retry can neither re-run a finished import, resurrect a dead-lettered one, nor steal
 *  a healthy in-flight one. */
export async function markInboxProcessing(db: Querier, inboxId: string): Promise<InboxRow | null> {
  const res = await db.query(
    `UPDATE public.bid_board_ingestion_inbox
     SET status = 'processing', attempts = attempts + 1, started_at = NOW(), updated_at = NOW(),
         lease_expires_at = NOW() + make_interval(secs => $2::int)
     WHERE id = $1
       AND attempts < max_attempts
       AND (
         status = 'queued'
         OR (status = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at < NOW()))
       )
     RETURNING *`,
    [inboxId, INBOX_LEASE_TTL_SECONDS]
  );
  return (res.rows[0] as InboxRow) ?? null;
}

/** Renew the in-flight lease (heartbeat). No-op unless the row is still 'processing' (this handler owns it),
 *  so a renewal can't touch a row a terminal write already finished. Best-effort — the caller ignores errors. */
export async function renewInboxLease(db: Querier, inboxId: string): Promise<void> {
  await db.query(
    `UPDATE public.bid_board_ingestion_inbox
     SET lease_expires_at = NOW() + make_interval(secs => $2::int)
     WHERE id = $1 AND status = 'processing'`,
    [inboxId, INBOX_LEASE_TTL_SECONDS]
  );
}

export async function markInboxSucceeded(
  db: Querier,
  inboxId: string,
  fields: { runId: string | null; metrics: unknown; warningsCount: number }
): Promise<void> {
  // Drop the (up to ~25MB) payload once the import has committed — the row is retained for idempotency +
  // status + the metrics snapshot, but keeping every scraped payload forever would bloat the table
  // unboundedly (a scrape every ~19min). A re-POST of the same key still dedupes to this 'succeeded' row.
  // status = 'processing' guard: idempotent against any terminal state — a stray/duplicate success write can
  // never flip an already-'failed' row back to 'succeeded'. It also makes recordSuccessWithRetry's retry a
  // clean no-op when a prior attempt's UPDATE committed but its ack was lost (the row is already 'succeeded').
  await db.query(
    `UPDATE public.bid_board_ingestion_inbox
     SET status = 'succeeded', run_id = $2, metrics = $3::jsonb, warnings_count = $4,
         payload = '{}'::jsonb, last_error = NULL, finished_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status = 'processing'`,
    [inboxId, fields.runId, fields.metrics == null ? null : JSON.stringify(fields.metrics), fields.warningsCount]
  );
}

/**
 * Record success with a bounded retry. The import has already COMMITTED when this runs, so a transient
 * failure of this inbox UPDATE must NOT bubble up as an ingest failure (that would re-run the committed
 * import). Retries with exponential backoff (~3s total across 6 attempts) so a short DB blip at the
 * import→record seam is absorbed durably.
 *
 * RESIDUAL (inherent to the two-transaction design — the importer is deliberately UNCHANGED and commits in
 * its OWN transaction, so there is no durable link from "import committed" to this separate inbox write): if
 * EVERY attempt genuinely fails to commit (a sustained outage of several seconds precisely at this seam), the
 * row stays 'processing' with its payload intact and the caller marks it failed + rethrows, so the job queue
 * retries and re-runs the import. That re-run is SERIALIZED by the office lock (not the concurrent row-
 * contention this inbox was built to stop) and converges the same deal rows, but it does duplicate the sync-
 * run + audit bookkeeping. The only complete close is to write this success INSIDE the importer's
 * transaction, which would couple + change ingestBidBoardRows — left as a deliberate follow-up.
 */
export async function recordSuccessWithRetry(
  db: Querier,
  inboxId: string,
  fields: { runId: string | null; metrics: unknown; warningsCount: number },
  attempts = 6
): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      await markInboxSucceeded(db, inboxId, fields);
      return;
    } catch (err) {
      lastErr = err;
      // Exponential backoff, capped: 100, 200, 400, 800, 1600ms between the 6 attempts.
      await new Promise((r) => setTimeout(r, Math.min(1600, 100 * 2 ** i)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Record a processing failure. Only a TERMINAL failure (the final attempt) writes status 'failed'; a
 * non-terminal failure leaves the row 'processing' so the SyncHub-visible status stays honest ('failed'
 * means genuinely dead-lettered, not "mid-backoff"). Either way the caller rethrows so the job queue
 * retries or dead-letters in lockstep.
 */
export async function markInboxFailed(
  db: Querier,
  inboxId: string,
  fields: { error: string; terminal: boolean }
): Promise<void> {
  if (fields.terminal) {
    // status = 'processing' guard: idempotent against any terminal state — if a concurrent path already
    // recorded 'succeeded' between the import and this catch, the terminal failure write is a no-op instead
    // of clobbering the real outcome (succeeded → failed).
    await db.query(
      `UPDATE public.bid_board_ingestion_inbox
       SET status = 'failed', last_error = $2, finished_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'processing'`,
      [inboxId, fields.error]
    );
  } else {
    // Non-terminal failure: the row stays 'processing' for the queue's backoff retry. RELEASE the lease
    // (lease_expires_at = NULL) so the retry's markInboxProcessing can re-claim it immediately — otherwise a
    // still-valid lease from this now-finished attempt would make the retry a no-op until the TTL elapsed.
    await db.query(
      `UPDATE public.bid_board_ingestion_inbox
       SET last_error = $2, updated_at = NOW(), lease_expires_at = NULL
       WHERE id = $1`,
      [inboxId, fields.error]
    );
  }
}

export interface InboxStatusRow {
  id: string;
  status: InboxStatus;
  attempts: number;
  max_attempts: number;
  run_id: string | null;
  warnings_count: number | null;
  last_error: string | null;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export async function readInboxStatusByKey(
  db: Querier,
  officeSlug: string,
  payloadHash: string
): Promise<InboxStatusRow | null> {
  const res = await db.query(
    `SELECT id, status, attempts, max_attempts, run_id, warnings_count, last_error,
            queued_at, started_at, finished_at, updated_at
     FROM public.bid_board_ingestion_inbox
     WHERE office_slug = $1 AND payload_hash = $2`,
    [officeSlug, payloadHash]
  );
  return (res.rows[0] as InboxStatusRow) ?? null;
}

/**
 * Crash recovery, safe to run repeatedly (worker startup + periodic). Two paths:
 *  (a) Mark stale 'processing' rows that already exhausted their attempts terminally 'failed' — a worker
 *      that died between the final attempt's claim and its terminal write would otherwise strand the row
 *      'processing' forever (which SyncHub reads as "still in flight" and never alerts on).
 *  (b) Re-enqueue a job for rows still 'queued' (a job that never landed) or stale 'processing' (worker
 *      died mid-import) that have attempts left and NO live (pending/processing) job. Uses the inbox row's
 *      OWN max_attempts so the re-enqueued job stays in lockstep. Terminal 'succeeded'/'failed' rows are
 *      never touched. Returns the count re-enqueued.
 */
export async function recoverOrphanedInboxJobs(
  db: Querier,
  opts: { staleProcessingMinutes?: number; staleJobMinutes?: number; retentionDays?: number } = {}
): Promise<number> {
  const staleMinutes = opts.staleProcessingMinutes ?? 10;
  const staleJobMinutes = opts.staleJobMinutes ?? 15;
  const retentionDays = opts.retentionDays ?? 14;

  // (0) Reclaim THIS job-type's own 'processing' jobs that have been stuck well past a normal run (worker
  // died mid-import). The queue's recoverStaleJobs() only runs at worker startup; this periodic sweep
  // covers a crash-without-restart window. Bounded far above a normal completion (lock wait + import).
  // LEASE-AWARE: a LIVE final-attempt import can legitimately run past staleJobMinutes while its handler keeps
  // renewing the inbox lease — do NOT reclaim its job. Reclaiming it would let another worker claim + noop the
  // job (the lease blocks re-claim), complete the queue row, and then the step-(a) sweep, seeing no live job,
  // would falsely 'fail' the still-running import (whose later markInboxSucceeded is then blocked by the
  // terminal-state guard). So reclaim only when the inbox lease has EXPIRED (the handler is genuinely gone).
  await db.query(
    `UPDATE public.job_queue AS j
     SET status = 'pending', run_after = NOW(), last_error = 'recovered stale bid_board_ingest job'
     WHERE j.job_type = $1::text
       AND j.status = 'processing'
       AND j.started_processing_at < NOW() - make_interval(mins => $2::int)
       AND NOT EXISTS (
         SELECT 1 FROM public.bid_board_ingestion_inbox i
         WHERE i.id::text = j.payload->>'inboxId'
           AND i.status = 'processing'
           AND i.lease_expires_at IS NOT NULL
           AND i.lease_expires_at >= NOW()
       )`,
    [BID_BOARD_INGEST_JOB_TYPE, staleJobMinutes]
  );

  const liveJobExists = `NOT EXISTS (
    SELECT 1 FROM public.job_queue j
    WHERE j.job_type = $1::text
      AND j.status IN ('pending', 'processing')
      AND j.payload->>'inboxId' = i.id::text
  )`;

  // (a) Terminalize a stale, attempts-exhausted 'processing' row ONLY when the worker is genuinely gone —
  // i.e. NO live job owns it AND its in-flight lease has EXPIRED. The lease guard is essential: a live
  // final-attempt import can have its queue job reclaimed + noop'd + completed (so no live job remains) while
  // its handler is STILL running and renewing the lease; without checking the lease, this would falsely
  // 'fail' a healthy in-flight import, and its later markInboxSucceeded would then be blocked by the
  // terminal-state guard. A fresh lease means the handler is alive — leave it be. (started_at gate retained
  // as a floor so a just-claimed row isn't terminalized before the lease even has a chance to lapse.)
  await db.query(
    `UPDATE public.bid_board_ingestion_inbox AS i
     SET status = 'failed',
         last_error = COALESCE(i.last_error, 'recovered: worker died on the final attempt'),
         finished_at = NOW(), updated_at = NOW()
     WHERE i.status = 'processing'
       AND i.attempts >= i.max_attempts
       AND i.started_at < NOW() - make_interval(mins => $2::int)
       AND (i.lease_expires_at IS NULL OR i.lease_expires_at < NOW())
       AND ${liveJobExists}`,
    [BID_BOARD_INGEST_JOB_TYPE, staleMinutes]
  );

  // (b) Re-enqueue rows still 'queued' or stale 'processing' with attempts left and no live job, using the
  // row's OWN max_attempts (lockstep). Two guards keep this safe under concurrent multi-worker recovery:
  //   1. If both replicas pass the NOT EXISTS snapshot and both INSERT, the partial UNIQUE index
  //      job_queue_bbi_one_live_job_idx (one live job per inboxId) makes the loser hit ON CONFLICT DO
  //      NOTHING — so only ONE job is enqueued and the shared inbox attempts counter isn't double-charged
  //      (which would prematurely dead-letter a recoverable row).
  //   2. Even if a duplicate job did run, processBidBoardInboxJob RE-CHECKS the inbox status after the
  //      per-office lock and skips the import when a prior holder already committed it (no duplicate import).
  const res = await db.query(
    `INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after, max_attempts)
     SELECT $1::text, jsonb_build_object('inboxId', i.id::text), i.office_id, 'pending', NOW(), i.max_attempts
     FROM public.bid_board_ingestion_inbox i
     WHERE i.attempts < i.max_attempts
       AND (
         i.status = 'queued'
         OR (i.status = 'processing' AND i.started_at < NOW() - make_interval(mins => $2::int))
       )
       AND ${liveJobExists}
     ON CONFLICT ((payload->>'inboxId'))
       WHERE job_type = 'bid_board_ingest' AND status IN ('pending', 'processing')
       DO NOTHING
     RETURNING id`,
    [BID_BOARD_INGEST_JOB_TYPE, staleMinutes]
  );

  // (c) Retention: delete terminal rows past the window so the inbox (and any retained failed payloads)
  // can't grow without bound. Idempotency for a re-POST past the window simply creates a fresh row.
  await db.query(
    `DELETE FROM public.bid_board_ingestion_inbox
     WHERE status IN ('succeeded', 'failed')
       AND COALESCE(finished_at, updated_at) < NOW() - make_interval(days => $1::int)`,
    [retentionDays]
  );

  return res.rowCount ?? res.rows.length;
}

export interface IngestResult {
  runId: string | null;
  metrics: unknown;
  warnings: string[];
}

export interface ProcessInboxDeps {
  db: Querier;
  inboxId: string;
  /** The real ingestBidBoardRows (kept UNCHANGED); injected so the state machine is testable with a mock. */
  ingest: (payload: any) => Promise<IngestResult>;
  /** Serialize per office. The worker supplies a pg session advisory lock; tests supply a pass-through. */
  withOfficeLock: <T>(officeSlug: string, fn: () => Promise<T>) => Promise<T>;
  /** Lease-renew (heartbeat) interval while an import runs. Defaults to INBOX_LEASE_RENEW_MS; tests override. */
  heartbeatMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export type ProcessInboxOutcome = "succeeded" | "noop";

/**
 * Process one inbox row: run the (unchanged) importer under the per-office lock and record the outcome.
 * Resolves 'succeeded'/'noop'; THROWS on any failure so the durable job queue retries with backoff (or
 * dead-letters on the final attempt, at which point the inbox is marked terminally 'failed').
 *
 * The row is CLAIMED (markInboxProcessing — increments attempts, loads the payload exactly once via
 * RETURNING *) BEFORE acquiring the office lock. That way a lock-acquisition or ingest failure both count
 * against the inbox's attempts in lockstep with the job's — so a persistent pre-ingest failure terminalizes
 * the row instead of looping the recovery re-enqueue. A terminal row ('succeeded'/'failed') yields a null
 * claim → noop, so the job completes without resurrecting finished work.
 */
export async function processBidBoardInboxJob(deps: ProcessInboxDeps): Promise<ProcessInboxOutcome> {
  const { db, inboxId } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});

  const claimed = await markInboxProcessing(db, inboxId);
  if (!claimed) {
    log(`[BidBoardIngest] inbox row ${inboxId} not claimable (already terminal, dead-lettered, or LEASED by a live handler) — noop`);
    return "noop";
  }

  // Renew the lease for the whole time this handler owns the row — through the office-lock wait AND the
  // import — so the stale-job sweep can't let a second handler re-claim a live long-running import (which
  // would burn an inbox attempt). Cleared in the finally below. unref so it never keeps the process alive.
  const heartbeat = setInterval(() => {
    void renewInboxLease(db, inboxId).catch(() => {});
  }, deps.heartbeatMs ?? INBOX_LEASE_RENEW_MS);
  (heartbeat as { unref?: () => void }).unref?.();

  const startedMs = now();
  const queueMs = startedMs - Date.parse(claimed.queued_at);
  const logMeta = {
    office: claimed.office_slug,
    inboxId,
    payloadHash: claimed.payload_hash,
    rowCount: claimed.row_count,
    attempt: claimed.attempts,
    maxAttempts: claimed.max_attempts,
    queueMs: Number.isFinite(queueMs) ? queueMs : undefined,
  };

  try {
    // The lock wraps ONLY the import + its terminal write (the deal-row contention). The claim above is a
    // cheap inbox UPDATE that doesn't touch deal rows, so it's safe outside the lock.
    let imported = false;
    await deps.withOfficeLock(claimed.office_slug, async () => {
      // Re-check status AFTER acquiring the lock. markInboxProcessing claims an in-flight 'processing' row
      // (needed so a genuinely-orphaned row can be recovered), so a DUPLICATE job — a concurrent recovery
      // re-enqueue, or a still-running job the stale-job sweep reclaimed — can also claim this row and
      // capture the payload before the lock. The lock only serializes; it does NOT dedupe. If the holder we
      // waited behind already COMMITTED the import, the row is now terminal — skip so we never re-run a
      // finished import (the duplicate-import incident this inbox exists to prevent). Only a still-open
      // 'processing' row (the previous holder died mid-import, or we ARE the first) proceeds to ingest.
      const current = await loadInboxRow(db, inboxId);
      if (current && (current.status === "succeeded" || current.status === "failed")) {
        log(
          `[BidBoardIngest] ${JSON.stringify({ ...logMeta, state: "noop_after_lock", status: current.status })}`
        );
        return;
      }
      imported = true;
      const { runId, metrics, warnings } = await deps.ingest(claimed.payload);
      // The import has COMMITTED. Recording success is post-commit bookkeeping — retry it so a transient
      // failure here can't get classified as an ingest failure (which would re-run the committed import on
      // the next attempt, duplicating the sync run + audit side-effects).
      await recordSuccessWithRetry(db, inboxId, { runId, metrics, warningsCount: warnings?.length ?? 0 });
      log(
        `[BidBoardIngest] ${JSON.stringify({
          ...logMeta,
          state: "succeeded",
          runId,
          warnings: warnings?.length ?? 0,
          processMs: now() - startedMs,
        })}`
      );
    });
    return imported ? "succeeded" : "noop";
  } catch (err) {
    const terminal = claimed.attempts >= claimed.max_attempts;
    const message = err instanceof Error ? err.message : String(err);
    await markInboxFailed(db, inboxId, { error: message, terminal });
    log(
      `[BidBoardIngest] ${JSON.stringify({
        ...logMeta,
        state: terminal ? "failed" : "retrying",
        error: message,
        processMs: now() - startedMs,
      })}`
    );
    // Rethrow so the job queue retries with backoff (or dead-letters on the terminal attempt).
    throw err;
  } finally {
    // Stop renewing the lease once we're done owning the row (success, noop, or failure/throw) — so a
    // genuinely dead handler's lease can expire and recovery can re-claim.
    clearInterval(heartbeat);
  }
}
