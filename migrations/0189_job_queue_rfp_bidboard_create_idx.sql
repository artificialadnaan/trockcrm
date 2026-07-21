-- Migration 0189: partial index on public.job_queue for the rfp_bidboard_create sweeps.
-- (0188 is reserved for the Bid Board 502 ingestion inbox on the CRM #935 branch.)
--
-- ROOT CAUSE: runRfpBidBoardCreateStuckDealSweep (worker/src/jobs/rfp-bidboard-create.ts) runs three
-- correlated public.job_queue lookups PER candidate deal, PER office, once every minute:
--   * a dead-create EXISTS  (status = 'dead')
--   * a live-retry NOT EXISTS (status IN ('pending','processing'))
--   * the surfaced-error subquery (status = 'dead' ... ORDER BY created_at DESC LIMIT 1)
-- all keyed on job_type = 'rfp_bidboard_create', office_id = $office, payload->>'dealId' = deal.id::text.
-- public.job_queue only carries job_queue_pending_idx (partial on status = 'pending', 0001_initial), so
-- these lookups have no supporting index. Because COMPLETED/DEAD jobs are retained, the queue grows
-- without bound and every tick Seq-Scans the whole table for each candidate deal.
--
-- FIX: a partial index covering (office_id, (payload->>'dealId'), status, created_at DESC) restricted to
-- job_type = 'rfp_bidboard_create' — small (only this job type), and its trailing created_at DESC also
-- serves the error subquery's ORDER BY ... LIMIT 1. job_queue is a PUBLIC (not per-tenant) table, so this
-- is a single plain CREATE INDEX (no tenant DO-loop). Idempotent via IF NOT EXISTS.
--
-- Schema source of truth: shared/src/schema/public/job-queue.ts declares the matching index() entry.

CREATE INDEX IF NOT EXISTS job_queue_rfp_bidboard_create_deal_idx
  ON public.job_queue (office_id, (payload->>'dealId'), status, created_at DESC)
  WHERE job_type = 'rfp_bidboard_create';
