-- Durable inbox for Bid Board → CRM ingestion.
--
-- WHY: the /api/bid-board-sync/ingest route used to run the ENTIRE import synchronously before returning
-- 202. A slow Dallas import let Railway's edge time out and synthesize a 502 to SyncHub while the CRM kept
-- working and committed; SyncHub then re-POSTed the full 25MB payload 3x, producing three overlapping
-- imports that contended on the same deal rows (incident 2026-07-19T06:16Z). This table decouples
-- ACCEPTANCE (fast, idempotent, durable) from PROCESSING (async, per-office-serialized worker job):
--   • the route hashes the raw request body (sha256) and UPSERTs here keyed by (office_slug, payload_hash),
--     so retries / concurrent duplicates of the same payload collapse to ONE logical ingestion;
--   • it enqueues a single public.job_queue row carrying only this row's id (the large JSON payload stays
--     OUT of job_queue, whose poller does SELECT * every tick);
--   • the worker runs ingestBidBoardRows unchanged and records queued→processing→succeeded/failed here;
--   • a signed status endpoint reads this table so SyncHub can resolve an ambiguous 502 without re-sending.
--
-- Public (not per-office): a single worker/route process serves every office, keyed by office_slug like
-- bid_board_sync_alert_state (migration 0164). office_id is a best-effort denormalization for the job FK.
CREATE TABLE IF NOT EXISTS public.bid_board_ingestion_inbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  office_slug     text NOT NULL,
  office_id       uuid REFERENCES public.offices(id),
  payload_hash    text NOT NULL,                 -- sha256 hex of the exact signed request body (idempotency key)
  payload         jsonb NOT NULL,                -- the full BidBoardSyncPayload; processed by the worker
  row_count       integer NOT NULL DEFAULT 0,
  source_filename text,
  -- The scrape's snapshot timestamp (payload.provenance.extractedAt). Used to keep same-office ingestion
  -- MONOTONIC: the per-office advisory lock serializes imports but does NOT preserve age order, so an OLDER
  -- snapshot whose job fell into queue backoff can run AFTER a newer one committed and regress the deal Bid
  -- Board mirror + bid_board_last_updated_at. Under the office lock the worker skips (no-op) an ingestion whose
  -- extracted_at is strictly older than the newest already-committed ('succeeded') snapshot for the office, so a
  -- stale snapshot can never overwrite newer mirror data (multi-replica reverse-order claims included). NULL when
  -- the sender omits provenance.extractedAt — a NULL snapshot is never treated as stale (falls back to importing).
  extracted_at    timestamptz,
  status          text NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'processing', 'succeeded', 'failed')),
  attempts        integer NOT NULL DEFAULT 0,    -- incremented by the worker in lockstep with the job's attempts
  max_attempts    integer NOT NULL DEFAULT 5,    -- 'failed' is only written on the FINAL attempt (terminal)
  run_id          uuid,                          -- the bid_board_sync_runs id produced by a successful import
  metrics         jsonb,                         -- IngestionMetrics snapshot on success
  warnings_count  integer,
  last_error      text,
  queued_at       timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  -- Lease/heartbeat for an in-flight import: markInboxProcessing stamps NOW()+TTL and the worker renews it
  -- while running, so a concurrent claimant can only re-claim a 'processing' row whose lease has EXPIRED (the
  -- handler died) — never a live long-running import (which would burn an inbox attempt).
  lease_expires_at timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- One logical ingestion per (office, payload). Retries and concurrent duplicate POSTs of the same body
  -- hit this constraint and are deduped to the existing row (ON CONFLICT DO NOTHING in the route).
  CONSTRAINT bid_board_ingestion_inbox_office_hash_uidx UNIQUE (office_slug, payload_hash)
);

-- Recovery + status scans look up by (office_slug, status).
CREATE INDEX IF NOT EXISTS bid_board_ingestion_inbox_office_status_idx
  ON public.bid_board_ingestion_inbox (office_slug, status);

-- The monotonic guard (processBidBoardInboxJob) reads MAX(extracted_at) over the office's already-'succeeded'
-- rows to decide whether an incoming snapshot is stale. Partial on 'succeeded' + keyed (office_slug,
-- extracted_at DESC) so that lookup is a tiny index scan regardless of inbox size.
CREATE INDEX IF NOT EXISTS bid_board_ingestion_inbox_office_extracted_idx
  ON public.bid_board_ingestion_inbox (office_slug, extracted_at DESC)
  WHERE status = 'succeeded';

-- NOTE ON CONCURRENCY: the two job_queue indexes below are written as plain CREATE INDEX IF NOT EXISTS. On
-- the existing prod job_queue (accumulated history), a plain build holds a write-blocking SHARE lock for its
-- duration — stalling job enqueues + worker outcome writes — and CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block, which is what the migration runner wraps each .sql file in. So this migration is
-- INTERCEPTED by the runner (server/src/migrations/runner.ts → runBidBoardIngestIndexMigration in
-- bid-board-ingest-indexes.ts): the runner builds these two CONCURRENTLY, out of transaction, BEFORE executing
-- this file — mirroring the audit-log / project-number-first-set index migrations. The plain statements below
-- then no-op via IF NOT EXISTS (and remain the source of truth for a fresh/CI DB where the table is empty and
-- the in-transaction build is instant + non-blocking).

-- Supporting index for this feature's periodic stale-job sweep (recoverOrphanedInboxJobs step 0), which runs
-- every ~60s:  UPDATE public.job_queue ... WHERE job_type = 'bid_board_ingest' AND status = 'processing'
--              AND started_processing_at < now() - interval.
-- The only pre-existing job_queue index (job_queue_pending_idx, partial on status='pending') cannot serve a
-- status='processing' predicate, so each tick would seq-scan the whole durable queue as its history grows.
-- Partial on the transient 'processing' rows (so it stays tiny) and keyed (job_type, started_processing_at)
-- so the sweep is an index range scan regardless of queue size, even with a parameterized job_type.
CREATE INDEX IF NOT EXISTS job_queue_processing_type_started_idx
  ON public.job_queue (job_type, started_processing_at)
  WHERE status = 'processing';

-- At most ONE live (pending/processing) bid_board_ingest job per inbox row. Under a multi-worker deployment
-- two recovery runs can both pass the re-enqueue's NOT EXISTS guard against their own snapshots and each
-- INSERT a job for the same orphaned row; duplicate jobs would then each charge the SHARED inbox attempts
-- counter (markInboxProcessing), exhausting max_attempts early and terminally failing a recoverable row.
-- This partial + expression unique index (keyed on the payload's inboxId) makes the second insert hit
-- ON CONFLICT DO NOTHING, so recovery is idempotent across replicas. Non-inbox job types have a NULL
-- payload->>'inboxId' and are excluded by the predicate, so this constrains only bid_board_ingest.
CREATE UNIQUE INDEX IF NOT EXISTS job_queue_bbi_one_live_job_idx
  ON public.job_queue ((payload->>'inboxId'))
  WHERE job_type = 'bid_board_ingest' AND status IN ('pending', 'processing');
