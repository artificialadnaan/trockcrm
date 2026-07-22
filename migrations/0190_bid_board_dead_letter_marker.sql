-- Migration 0190: per-row dead-letter alert marker on the Bid Board ingestion inbox.
--
-- ROOT CAUSE (SyncHub #59, P1 "Queued Jobs Can Fail Silently"): since #935 /ingest returns 202 the moment it
-- durably enqueues the inbox row and the import runs async in the worker. A row that later terminalizes to
-- 'failed' is un-observed by SyncHub's push alert (it saw the 202) AND by the absence-of-success heartbeat
-- (which stays quiet while other imports still succeed). The CRM worker owns that failure, so the heartbeat
-- cron gains a dead-letter SWEEP that emails on newly-'failed' rows.
--
-- Per-ROW marker, NOT a timestamp watermark (Codex + greptile P1): a per-office `finished_at > watermark`
-- cursor can SKIP a failure whose transaction commits out of order or shares a finished_at with an
-- already-alerted row — PostgreSQL timestamps are not unique and now() is the transaction-START time, so a
-- slow failure can commit with finished_at <= the saved watermark and be excluded forever. Stamping each row
-- once is immune: the sweep selects rows still NULL and marks them, so no terminalization is skipped and each
-- dead-lettered row alerts exactly once regardless of commit ordering.
--
-- Additive + nullable (existing 'failed' rows read NULL = eligible on the first sweep). Public (not
-- per-tenant) table; a single idempotent ALTER. Mirrors the drizzle definition in
-- shared/src/schema/public/bid-board-ingestion-inbox.ts so db:generate sees parity, not drift.
--
-- The partial index that serves the sweep's predicate lives in its OWN single-statement migration (0191)
-- so it can build CONCURRENTLY: bid_board_ingestion_inbox is written continuously by the ingest worker
-- (status/lease/finished_at updates), so a plain CREATE INDEX would take a write-blocking lock. CREATE INDEX
-- CONCURRENTLY cannot run inside a transaction block, and a file with more than one statement runs as an
-- implicit transaction, so the index cannot share this ALTER's file — it is split out (see 0191).

ALTER TABLE public.bid_board_ingestion_inbox
  ADD COLUMN IF NOT EXISTS dead_letter_alerted_at timestamptz;
