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
-- is a single CREATE INDEX (no tenant DO-loop). Idempotent via IF NOT EXISTS.
--
-- CONCURRENTLY (finding): public.job_queue is written continuously (API enqueues + worker status flips) and
-- retains COMPLETED/DEAD rows, so a plain CREATE INDEX would hold a SHARE lock — blocking every insert/status
-- update on a large table for the whole build. CREATE INDEX CONCURRENTLY cannot run inside a transaction
-- block, but the migration runner (server/src/migrations/runner.ts) executes each .sql file with a bare
-- client.query(sql) — no BEGIN/COMMIT wrapper — and this file is a SINGLE statement, so PostgreSQL runs it in
-- autocommit and CONCURRENTLY is permitted. (The 0138/0120/0167 CONCURRENTLY caveats apply only to the
-- PER-TENANT DO-loop migrations, which ARE transactional; this public single-index migration is not.)
--
-- If a prior CONCURRENTLY build is interrupted it can leave an INVALID index stub; IF NOT EXISTS would then
-- skip the rebuild. That risk is acceptable here (a re-run of the migration file only happens if the
-- _migrations row was not recorded, i.e. the query itself errored) — reindex/drop-invalid is an ops step.
--
-- Schema source of truth: shared/src/schema/public/job-queue.ts declares the matching index() entry.

CREATE INDEX CONCURRENTLY IF NOT EXISTS job_queue_rfp_bidboard_create_deal_idx
  ON public.job_queue (office_id, (payload->>'dealId'), status, created_at DESC)
  WHERE job_type = 'rfp_bidboard_create';
