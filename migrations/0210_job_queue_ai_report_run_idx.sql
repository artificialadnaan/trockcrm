-- Migration 0210: partial index on public.job_queue for the AI-report stale-run sweep.
--
-- ROOT CAUSE: expireStaleAiReportRuns (server/src/modules/field/ai-report-runs.ts) runs on EVERY AI-report
-- enqueue, and decides whether a QUEUED run is abandoned by asking whether a live delivery still exists:
--   NOT EXISTS (SELECT 1 FROM public.job_queue
--                WHERE job_type = 'ai_report_generation'
--                  AND status IN ('pending','processing')
--                  AND payload->>'runId' = r.id::text)
-- Nothing indexes payload->>'runId'. job_queue_pending_idx (0001) is partial on status = 'pending' and leads
-- with (status, run_after), so it cannot serve the runId equality, and nothing covers 'processing' by
-- payload at all. Because COMPLETED/DEAD rows are retained, job_queue grows without bound — and the case
-- this predicate exists for is precisely a BACKLOG, i.e. exactly when the scan is largest.
--
-- FIX: a partial expression index on (payload->>'runId'), restricted to this job type AND the two live
-- statuses. That predicate matches the subquery's exactly, and it keeps the index tiny — it holds only
-- AI-report deliveries that are still in flight, and rows leave it as soon as they reach a terminal status.
-- job_queue is a PUBLIC (not per-tenant) table, so this is a single CREATE INDEX with no tenant DO-loop.
--
-- CONCURRENTLY: same reasoning as 0189. public.job_queue is written continuously (API enqueues + worker
-- status flips), so a plain CREATE INDEX would hold a SHARE lock and block every insert and status update
-- for the whole build. CREATE INDEX CONCURRENTLY cannot run inside a transaction block, but the migration
-- runner (server/src/migrations/runner.ts) executes each .sql file with a bare client.query(sql) — no
-- BEGIN/COMMIT wrapper — and this file is a SINGLE statement, so PostgreSQL runs it in autocommit and
-- CONCURRENTLY is permitted.
--
-- If an interrupted CONCURRENTLY build leaves an INVALID index stub, IF NOT EXISTS would skip the rebuild;
-- same accepted trade-off as 0189 (reindex/drop-invalid is an ops step).
--
-- Schema source of truth: shared/src/schema/public/job-queue.ts declares the matching index() entry.

CREATE INDEX CONCURRENTLY IF NOT EXISTS job_queue_ai_report_run_idx
  ON public.job_queue ((payload->>'runId'))
  WHERE job_type = 'ai_report_generation' AND status IN ('pending', 'processing');
