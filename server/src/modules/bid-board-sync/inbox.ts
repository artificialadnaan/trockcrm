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

/**
 * Extract the scrape's snapshot timestamp (payload.provenance.extractedAt / extracted_at) as an ISO string, or
 * null if absent/blank/unparseable. Mirrors ingestBidBoardRows' own extractedAt resolution (textValue of the two
 * aliases) so the value we persist for the monotonic guard is the SAME instant the importer stamps into
 * bid_board_last_updated_at. A value that doesn't parse to a real date is treated as absent (null) — the guard
 * never blocks on an uninterpretable timestamp.
 */
export function extractPayloadExtractedAt(payload: any): string | null {
  const raw =
    (typeof payload?.provenance?.extractedAt === "string" && payload.provenance.extractedAt.trim()) ||
    (typeof payload?.provenance?.extracted_at === "string" && payload.provenance.extracted_at.trim()) ||
    null;
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  // Future-skew bound: a signed sender with a clock/config error could submit an implausibly-FUTURE
  // extractedAt. Persisting it as the office watermark would then classify every subsequent correctly-timed
  // snapshot as stale (skipped) until the poisoned row ages out of retention. Reject anything more than an
  // hour ahead of now — treat it as no provenance (null never blocks the monotonic guard, so the snapshot
  // still imports; it just doesn't get to poison the watermark).
  if (ms > Date.now() + 60 * 60 * 1000) return null;
  return new Date(ms).toISOString();
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
  // Persist the scrape's snapshot timestamp so the worker can enforce per-office monotonicity (skip a stale
  // snapshot). Derived from the payload here so the route doesn't have to thread it through.
  const extractedAt = extractPayloadExtractedAt(args.payload);

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
    extractedAt,
  ];

  // Loop to close a rare race: the CTE can see the UNIQUE conflict (row exists) while the retention sweep
  // then deletes that expired terminal row before the duplicate lookup — leaving neither an insert nor an
  // existing row. Re-running the CTE once (the conflicting row is now gone) inserts fresh. Bounded so a
  // pathological ping-pong can't spin.
  for (let attempt = 0; attempt < 3; attempt++) {
    const inserted = await db.query(
      `WITH ins AS (
         INSERT INTO public.bid_board_ingestion_inbox
           (office_slug, office_id, payload_hash, payload, row_count, source_filename, status, max_attempts, extracted_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, 'queued', $7, $9::timestamptz)
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
  extracted_at: string | null;
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

export interface InboxControlRow {
  status: InboxStatus;
  attempts: number;
  max_attempts: number;
  lease_expires_at: string | null;
}

/**
 * Lightweight control-flow load: status + attempts + lease ONLY, never the (up to 25 MB) payload. Used for the
 * post-lock recheck and the leased/terminal no-claim decision, where markInboxProcessing already returned the
 * payload via RETURNING * — reloading it via loadInboxRow's SELECT * would hold a SECOND copy of the whole
 * import in worker heap for the duration of the running import (precisely the large payloads this feature adds).
 */
export async function loadInboxControlRow(db: Querier, inboxId: string): Promise<InboxControlRow | null> {
  const res = await db.query(
    `SELECT status, attempts, max_attempts, lease_expires_at FROM public.bid_board_ingestion_inbox WHERE id = $1`,
    [inboxId]
  );
  return (res.rows[0] as InboxControlRow) ?? null;
}

/**
 * Newest snapshot (extracted_at) that has ALREADY committed for this office — the MAX extracted_at over the
 * office's 'succeeded' rows, EXCLUDING the row being processed (a re-run of the very same row, e.g. a recovered
 * mid-import, must not measure itself as stale). Returns null when no prior snapshot has committed or none carried
 * an extracted_at. Read under the per-office lock so it observes the latest committed state (multi-replica /
 * reverse-order claims included).
 */
export async function latestCommittedExtractedAt(
  db: Querier,
  officeSlug: string,
  excludeInboxId: string
): Promise<string | null> {
  const res = await db.query(
    `SELECT MAX(extracted_at) AS latest
     FROM public.bid_board_ingestion_inbox
     WHERE office_slug = $1 AND status = 'succeeded' AND extracted_at IS NOT NULL AND id <> $2`,
    [officeSlug, excludeInboxId]
  );
  const latest = res.rows[0]?.latest ?? null;
  return latest == null ? null : String(latest);
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

/**
 * Outcome of the guarded success write:
 *  - "recorded":         the UPDATE landed (row moved 'processing' → 'succeeded').
 *  - "already_succeeded": 0 rows AND the row is already 'succeeded' — a clean idempotent no-op (a retry of a
 *                         write whose ack was lost). Nothing to do.
 *  - "conflict_failed":   0 rows AND the row is 'failed' — the import COMMITTED but recovery terminalized the
 *                         inbox 'failed' first (a slow final attempt outlived its lease while heartbeats stalled,
 *                         then the import committed). Silently reporting success would leave the status endpoint
 *                         permanently reporting 'failed' for a run that actually succeeded, so the caller must
 *                         surface/reconcile this rather than treat it as success.
 */
export type MarkSucceededResult = "recorded" | "already_succeeded" | "conflict_failed";

export async function markInboxSucceeded(
  db: Querier,
  inboxId: string,
  fields: { runId: string | null; metrics: unknown; warningsCount: number }
): Promise<MarkSucceededResult> {
  // Drop the (up to ~25MB) payload once the import has committed — the row is retained for idempotency +
  // status + the metrics snapshot, but keeping every scraped payload forever would bloat the table
  // unboundedly (a scrape every ~19min). A re-POST of the same key still dedupes to this 'succeeded' row.
  // status = 'processing' guard: idempotent against any terminal state — a stray/duplicate success write can
  // never flip an already-'failed' row back to 'succeeded'. It also makes recordSuccessWithRetry's retry a
  // clean no-op when a prior attempt's UPDATE committed but its ack was lost (the row is already 'succeeded').
  const res = await db.query(
    `UPDATE public.bid_board_ingestion_inbox
     SET status = 'succeeded', run_id = $2, metrics = $3::jsonb, warnings_count = $4,
         payload = '{}'::jsonb, last_error = NULL, finished_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status = 'processing'`,
    [inboxId, fields.runId, fields.metrics == null ? null : JSON.stringify(fields.metrics), fields.warningsCount]
  );
  if ((res.rowCount ?? 0) > 0) return "recorded";
  // 0 rows: the status='processing' guard blocked us — the row is already terminal. Distinguish a benign
  // already-'succeeded' (idempotent no-op) from a 'failed' row that CONTRADICTS this committed import.
  const row = await loadInboxControlRow(db, inboxId);
  return row?.status === "failed" ? "conflict_failed" : "already_succeeded";
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
  attempts = 6,
  log: (line: string) => void = () => {}
): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const outcome = await markInboxSucceeded(db, inboxId, fields);
      if (outcome === "conflict_failed") {
        // The import COMMITTED but the inbox row was already terminalized 'failed' (recovery outran a slow final
        // attempt whose heartbeats stalled). Leaving it 'failed' would make the status endpoint permanently lie
        // about a run that actually succeeded. RECONCILE: flip the stale-'failed' row to 'succeeded' with this
        // run's metrics. Guarded on status='failed' so it can't clobber any other terminal transition, and it
        // preserves the payload-drop + run bookkeeping markInboxSucceeded would have written.
        await reconcileFailedButCommitted(db, inboxId, fields);
        log(
          `[BidBoardIngest] ${JSON.stringify({
            inboxId,
            state: "reconciled_failed_to_succeeded",
            runId: fields.runId,
            note: "import committed but inbox was terminalized 'failed' by recovery — flipped to 'succeeded'",
          })}`
        );
      }
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
 * Reconcile the narrow window where the import COMMITTED but the inbox was already terminalized 'failed' by
 * recovery (the final-attempt import outlived its lease while heartbeats stalled, recovery step (a) failed the
 * row, then the import committed). The committed import is the ground truth, so flip 'failed' → 'succeeded'.
 * Guarded on status='failed' so it's an idempotent no-op once reconciled and can never touch a 'processing' or
 * 'succeeded' row. Best-effort part of recordSuccessWithRetry's own bounded retry loop.
 */
export async function reconcileFailedButCommitted(
  db: Querier,
  inboxId: string,
  fields: { runId: string | null; metrics: unknown; warningsCount: number }
): Promise<void> {
  await db.query(
    `UPDATE public.bid_board_ingestion_inbox
     SET status = 'succeeded', run_id = $2, metrics = $3::jsonb, warnings_count = $4,
         payload = '{}'::jsonb, last_error = NULL, finished_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status = 'failed'`,
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
  fields: { error: string; terminal: boolean; attempt: number }
): Promise<void> {
  if (fields.terminal) {
    // status='processing' + attempts guard: idempotent against any terminal state (a concurrent 'succeeded'
    // write is not clobbered), AND bound to the CLAIMING attempt so a stale handler whose row another replica
    // already reclaimed (a new attempt) can't stomp that live attempt.
    await db.query(
      `UPDATE public.bid_board_ingestion_inbox
       SET status = 'failed', last_error = $2, finished_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'processing' AND attempts = $3`,
      [inboxId, fields.error, fields.attempt]
    );
  } else {
    // Non-terminal failure: the row stays 'processing' for the queue's backoff retry. RELEASE the lease
    // (lease_expires_at = NULL) so the retry's markInboxProcessing can re-claim it immediately. Bound to the
    // CLAIMING attempt so a stale handler unwinding AFTER another replica reclaimed the row (which bumped
    // attempts) can't clear the NEW handler's live lease — which would let recovery reclaim a running import.
    await db.query(
      `UPDATE public.bid_board_ingestion_inbox
       SET last_error = $2, updated_at = NOW(), lease_expires_at = NULL
       WHERE id = $1 AND attempts = $3`,
      [inboxId, fields.error, fields.attempt]
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
         OR (i.status = 'processing'
             AND i.started_at < NOW() - make_interval(mins => $2::int)
             -- Same lease guard as steps (0)/(a): a live import renewing its lease must NOT be re-enqueued,
             -- even if its queue row vanished (e.g. the generic recoverStaleJobs reclaimed it). Otherwise the
             -- new job just no-ops on the fresh lease and completes, and the 60s sweep churns out completed
             -- jobs — growing job_queue and burning poll capacity — until the original import finishes.
             AND (i.lease_expires_at IS NULL OR i.lease_expires_at < NOW()))
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
       AND COALESCE(finished_at, updated_at) < NOW() - make_interval(days => $1::int)
       -- Never delete a 'failed' row that has NOT yet been dead-letter-alerted. If the heartbeat cron / email
       -- transport is down through the whole retention window, the dead-letter sweep would otherwise lose the
       -- alert forever when the row ages out. Keep unalerted failures until the sweep stamps
       -- dead_letter_alerted_at (a genuine dead-letter is alerted at most one grace-cycle after it fails, so
       -- this only preserves rows the monitor never got to). (Codex P2)
       AND NOT (status = 'failed' AND dead_letter_alerted_at IS NULL)
       -- Keep the newest succeeded snapshot PER OFFICE (the monotonic watermark latestCommittedExtractedAt
       -- reads) regardless of age. Otherwise a long (>retention) worker/SyncHub outage would delete an office's
       -- only watermark row, and a delayed/replayed OLDER payload could then pass the monotonic guard and
       -- overwrite the newer Bid Board mirror already stored in the tenant schema.
       AND id NOT IN (
         SELECT DISTINCT ON (office_slug) id
         FROM public.bid_board_ingestion_inbox
         WHERE status = 'succeeded' AND extracted_at IS NOT NULL
         ORDER BY office_slug, extracted_at DESC, id DESC
       )`,
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

export type ProcessInboxOutcome =
  | "succeeded"
  | "noop"
  // The row is LEASED by a live handler (another replica is mid-import): the caller should DEFER the queue
  // job (not complete it), coming back after the lease would lapse.
  | { status: "deferred"; runAfterSeconds: number; reason: string };

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
    // markInboxProcessing yields null for THREE cases; a LIVE-leased 'processing' row (another handler is
    // actively importing) must NOT be treated like a terminal/exhausted one. Completing the queue job for a
    // leased row is wrong: if that handler then dies, its attempt-bound queue outcome can't land (a duplicate
    // claim already bumped attempts), so the inbox would sit 'processing' until the slow periodic sweep. DEFER
    // instead — the queue re-runs this job just after the lease would lapse, re-driving the inbox promptly if
    // the owner died (or deferring again if it's still alive). Terminal/dead-lettered/attempts-exhausted rows
    // stay a noop so the job completes without resurrecting finished work.
    const row = await loadInboxControlRow(db, inboxId);
    const leaseMs = row?.lease_expires_at ? Date.parse(row.lease_expires_at) : NaN;
    const nowMs = now();
    if (row?.status === "processing" && row.attempts < row.max_attempts && Number.isFinite(leaseMs) && leaseMs > nowMs) {
      // Come back just after the current lease lapses (+ buffer), bounded to the TTL so clock skew between the
      // DB-stamped lease and this process can't defer for an absurd span.
      const runAfterSeconds = Math.min(
        INBOX_LEASE_TTL_SECONDS + 5,
        Math.max(1, Math.ceil((leaseMs - nowMs) / 1000) + 2),
      );
      log(`[BidBoardIngest] inbox row ${inboxId} LEASED by a live handler — deferring ${runAfterSeconds}s (not completing)`);
      return { status: "deferred", runAfterSeconds, reason: "inbox lease held by a live handler" };
    }
    log(`[BidBoardIngest] inbox row ${inboxId} not claimable (terminal / dead-lettered / attempts exhausted) — noop`);
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
    // The row was terminalized 'succeeded' as a deliberate stale-snapshot skip (monotonic guard) rather than by
    // running the importer. The queue still COMPLETES (no retry) — the outcome is a "noop" (nothing imported).
    let skippedStale = false;
    await deps.withOfficeLock(claimed.office_slug, async () => {
      // Re-check status AFTER acquiring the lock. markInboxProcessing claims an in-flight 'processing' row
      // (needed so a genuinely-orphaned row can be recovered), so a DUPLICATE job — a concurrent recovery
      // re-enqueue, or a still-running job the stale-job sweep reclaimed — can also claim this row and
      // capture the payload before the lock. The lock only serializes; it does NOT dedupe. If the holder we
      // waited behind already COMMITTED the import, the row is now terminal — skip so we never re-run a
      // finished import (the duplicate-import incident this inbox exists to prevent). Only a still-open
      // 'processing' row (the previous holder died mid-import, or we ARE the first) proceeds to ingest.
      const current = await loadInboxControlRow(db, inboxId);
      if (current && (current.status === "succeeded" || current.status === "failed")) {
        log(
          `[BidBoardIngest] ${JSON.stringify({ ...logMeta, state: "noop_after_lock", status: current.status })}`
        );
        return;
      }

      // MONOTONIC GUARD (per office). The advisory lock serializes imports but does NOT preserve age order: an
      // OLDER snapshot whose job fell into queue backoff (or a reverse-order multi-replica claim) can reach this
      // point AFTER a newer snapshot already committed. Running the (unchanged) importer would overwrite the deal
      // Bid Board mirror + bid_board_last_updated_at with STALE data. Read under the lock — so it observes the
      // newest committed state — and SKIP (terminal no-op success) when this snapshot is strictly older than the
      // office's newest already-committed one. Only compares when BOTH timestamps are present: a NULL incoming or
      // NULL prior snapshot never blocks (we can't order them), preserving legacy no-provenance behavior. Equal
      // timestamps still import (idempotent re-apply of the same snapshot converges the same rows).
      if (claimed.extracted_at) {
        const latestCommitted = await latestCommittedExtractedAt(db, claimed.office_slug, inboxId);
        if (latestCommitted && Date.parse(claimed.extracted_at) < Date.parse(latestCommitted)) {
          skippedStale = true;
          await recordSuccessWithRetry(db, inboxId, {
            runId: null,
            metrics: { skipped: "stale_snapshot", extractedAt: claimed.extracted_at, latestCommitted },
            warningsCount: 0,
          });
          log(
            `[BidBoardIngest] ${JSON.stringify({
              ...logMeta,
              state: "skipped_stale_snapshot",
              extractedAt: claimed.extracted_at,
              latestCommitted,
              processMs: now() - startedMs,
            })}`
          );
          return;
        }
      }

      imported = true;
      const { runId, metrics, warnings } = await deps.ingest(claimed.payload);
      // The import has COMMITTED. Recording success is post-commit bookkeeping — retry it so a transient
      // failure here can't get classified as an ingest failure (which would re-run the committed import on
      // the next attempt, duplicating the sync run + audit side-effects). Pass `log` so a failed→succeeded
      // reconcile (import committed but recovery already terminalized the row 'failed') is surfaced.
      await recordSuccessWithRetry(db, inboxId, { runId, metrics, warningsCount: warnings?.length ?? 0 }, 6, log);
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
    // "succeeded" only when we actually ran the import. A stale-snapshot skip terminalized the row 'succeeded'
    // but imported nothing → "noop" (the queue completes without a retry), same as an after-lock terminal skip.
    if (skippedStale) return "noop";
    return imported ? "succeeded" : "noop";
  } catch (err) {
    const terminal = claimed.attempts >= claimed.max_attempts;
    const message = err instanceof Error ? err.message : String(err);
    await markInboxFailed(db, inboxId, { error: message, terminal, attempt: claimed.attempts });
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
