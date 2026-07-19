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
    [
      args.officeSlug,
      officeId,
      args.payloadHash,
      JSON.stringify(args.payload),
      args.rowCount,
      args.sourceFilename,
      maxAttempts,
      BID_BOARD_INGEST_JOB_TYPE,
    ]
  );

  if (inserted.rows.length > 0) {
    return { inboxId: inserted.rows[0].id, status: "queued", duplicate: false, idempotencyKey: args.payloadHash };
  }

  // Duplicate: a row already exists for (office, hash) WITH its job (the insert+enqueue is atomic). Return
  // its current status; do NOT enqueue again.
  const existing = await db.query(
    `SELECT id, status FROM public.bid_board_ingestion_inbox WHERE office_slug = $1 AND payload_hash = $2`,
    [args.officeSlug, args.payloadHash]
  );
  const row = existing.rows[0];
  return {
    inboxId: row.id,
    status: row.status as InboxStatus,
    duplicate: true,
    idempotencyKey: args.payloadHash,
  };
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
}

export async function loadInboxRow(db: Querier, inboxId: string): Promise<InboxRow | null> {
  const res = await db.query(`SELECT * FROM public.bid_board_ingestion_inbox WHERE id = $1`, [inboxId]);
  return (res.rows[0] as InboxRow) ?? null;
}

/** Transition a claimable (queued or in-flight) row → processing, stamping the attempt + start time.
 *  Returns the updated row, or null for a TERMINAL row ('succeeded' → already done; 'failed' →
 *  dead-lettered): a no-op so a drifting job retry can neither re-run a finished import nor resurrect a
 *  terminally-failed one. */
export async function markInboxProcessing(db: Querier, inboxId: string): Promise<InboxRow | null> {
  const res = await db.query(
    `UPDATE public.bid_board_ingestion_inbox
     SET status = 'processing', attempts = attempts + 1, started_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status IN ('queued', 'processing')
     RETURNING *`,
    [inboxId]
  );
  return (res.rows[0] as InboxRow) ?? null;
}

export async function markInboxSucceeded(
  db: Querier,
  inboxId: string,
  fields: { runId: string | null; metrics: unknown; warningsCount: number }
): Promise<void> {
  await db.query(
    `UPDATE public.bid_board_ingestion_inbox
     SET status = 'succeeded', run_id = $2, metrics = $3::jsonb, warnings_count = $4,
         last_error = NULL, finished_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [inboxId, fields.runId, fields.metrics == null ? null : JSON.stringify(fields.metrics), fields.warningsCount]
  );
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
    await db.query(
      `UPDATE public.bid_board_ingestion_inbox
       SET status = 'failed', last_error = $2, finished_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [inboxId, fields.error]
    );
  } else {
    await db.query(
      `UPDATE public.bid_board_ingestion_inbox
       SET last_error = $2, updated_at = NOW()
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
  opts: { staleProcessingMinutes?: number } = {}
): Promise<number> {
  const staleMinutes = opts.staleProcessingMinutes ?? 10;

  await db.query(
    `UPDATE public.bid_board_ingestion_inbox
     SET status = 'failed',
         last_error = COALESCE(last_error, 'recovered: worker died on the final attempt'),
         finished_at = NOW(), updated_at = NOW()
     WHERE status = 'processing'
       AND attempts >= max_attempts
       AND started_at < NOW() - make_interval(mins => $1::int)`,
    [staleMinutes]
  );

  const res = await db.query(
    `INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after, max_attempts)
     SELECT $1::text, jsonb_build_object('inboxId', i.id::text), i.office_id, 'pending', NOW(), i.max_attempts
     FROM public.bid_board_ingestion_inbox i
     WHERE i.attempts < i.max_attempts
       AND (
         i.status = 'queued'
         OR (i.status = 'processing' AND i.started_at < NOW() - make_interval(mins => $2::int))
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.job_queue j
         WHERE j.job_type = $1::text
           AND j.status IN ('pending', 'processing')
           AND j.payload->>'inboxId' = i.id::text
       )
     RETURNING id`,
    [BID_BOARD_INGEST_JOB_TYPE, staleMinutes]
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
  now?: () => number;
  log?: (line: string) => void;
}

export type ProcessInboxOutcome = "succeeded" | "noop";

/**
 * Process one inbox row: acquire the per-office lock, run the (unchanged) importer, and record the outcome.
 * Resolves 'succeeded'/'noop'; THROWS on any ingest failure so the durable job queue retries with backoff
 * (or dead-letters on the final attempt, at which point the inbox is marked terminally 'failed').
 */
export async function processBidBoardInboxJob(deps: ProcessInboxDeps): Promise<ProcessInboxOutcome> {
  const { db, inboxId } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});

  const pre = await loadInboxRow(db, inboxId);
  if (!pre) {
    log(`[BidBoardIngest] inbox row ${inboxId} not found — nothing to process`);
    return "noop";
  }
  if (pre.status === "succeeded") {
    log(`[BidBoardIngest] inbox row ${inboxId} already succeeded — skipping (idempotent)`);
    return "noop";
  }

  return await deps.withOfficeLock(pre.office_slug, async () => {
    // Re-read under the lock: a sibling worker may have finished it while we waited.
    const locked = await loadInboxRow(db, inboxId);
    if (!locked || locked.status === "succeeded") return "noop";

    const claimed = await markInboxProcessing(db, inboxId);
    if (!claimed) return "noop"; // flipped to 'succeeded' between the read and the update

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
      const { runId, metrics, warnings } = await deps.ingest(claimed.payload);
      await markInboxSucceeded(db, inboxId, { runId, metrics, warningsCount: warnings?.length ?? 0 });
      log(
        `[BidBoardIngest] ${JSON.stringify({
          ...logMeta,
          state: "succeeded",
          runId,
          warnings: warnings?.length ?? 0,
          processMs: now() - startedMs,
        })}`
      );
      return "succeeded";
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
    }
  });
}
