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

-- NOTE ON CONCURRENCY: the two job_queue indexes below are written as plain CREATE INDEX IF NOT EXISTS, NOT
-- CONCURRENTLY. The migration runner executes each .sql file as ONE multi-statement query (implicit
-- transaction), and CREATE INDEX CONCURRENTLY cannot run inside a transaction block — so in-file CONCURRENTLY
-- would error. The codebase's pattern for a concurrent build (a dedicated .ts helper + a runner special-case,
-- e.g. project-number-first-set-index.ts) is deliberately NOT added here to keep this incident fix minimal.
-- On the existing prod job_queue, build these two CONCURRENTLY OUT-OF-BAND (they are IF NOT EXISTS, so the
-- migration then no-ops):
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS job_queue_processing_type_started_idx
--     ON public.job_queue (job_type, started_processing_at) WHERE status = 'processing';
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS job_queue_bbi_one_live_job_idx
--     ON public.job_queue ((payload->>'inboxId')) WHERE job_type = 'bid_board_ingest' AND status IN ('pending','processing');

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
