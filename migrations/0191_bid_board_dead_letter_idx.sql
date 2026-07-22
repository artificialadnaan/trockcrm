-- Migration 0191: partial index on public.bid_board_ingestion_inbox for the heartbeat dead-letter sweep.
-- (Split out of 0190, which keeps only the additive ALTER; see below for why the index needs its own file.)
--
-- ROOT CAUSE: the heartbeat cron's dead-letter sweep (server/src/scripts/bid-board-sync-heartbeat.ts)
-- selects still-unalerted terminal-'failed' inbox rows per office, aged past the reconcile grace, with the
-- exact predicate:
--   WHERE office_slug = $1 AND status = 'failed' AND dead_letter_alerted_at IS NULL
--     AND finished_at IS NOT NULL AND finished_at < NOW() - <grace>  ORDER BY finished_at ASC, id ASC
-- A partial index on (office_slug, finished_at) WHERE status = 'failed' AND dead_letter_alerted_at IS NULL
-- serves that lookup and its ORDER BY, and stays tiny — a stamped or non-'failed' row drops out of it.
--
-- CONCURRENTLY (CodeRabbit/Squawk/SQLFluff finding): public.bid_board_ingestion_inbox is written
-- continuously by the ingest worker (queued→processing→succeeded/failed plus lease/finished_at updates), so
-- a plain CREATE INDEX would hold a SHARE lock — blocking every insert/status update for the build's
-- duration. CREATE INDEX CONCURRENTLY cannot run inside a transaction block, but the migration runner
-- (server/src/migrations/runner.ts) executes each .sql file with a bare client.query(sql) — no BEGIN/COMMIT
-- wrapper — and this file is a SINGLE statement, so PostgreSQL runs it in autocommit and CONCURRENTLY is
-- permitted. This is exactly why the index was split out of 0190 (which also carries an ALTER): a file with
-- more than one statement runs as an implicit transaction, which would reject CONCURRENTLY. (The same
-- single-statement CONCURRENTLY pattern is documented in 0189; the 0138/0120/0167 CONCURRENTLY caveats apply
-- only to the PER-TENANT DO-loop migrations, which ARE transactional — this public single-index one is not.)
--
-- If a prior CONCURRENTLY build is interrupted it can leave an INVALID index stub; IF NOT EXISTS would then
-- skip the rebuild. That risk is acceptable here (a re-run of the migration file only happens if the
-- _migrations row was not recorded, i.e. the query itself errored) — reindex/drop-invalid is an ops step.
--
-- Schema source of truth: shared/src/schema/public/bid-board-ingestion-inbox.ts declares the matching
-- index() entry (bid_board_ingestion_inbox_dead_letter_idx) so db:generate sees parity, not drift.

CREATE INDEX CONCURRENTLY IF NOT EXISTS bid_board_ingestion_inbox_dead_letter_idx
  ON public.bid_board_ingestion_inbox (office_slug, finished_at)
  WHERE status = 'failed' AND dead_letter_alerted_at IS NULL;
