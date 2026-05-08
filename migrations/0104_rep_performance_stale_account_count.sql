ALTER TABLE rep_performance_snapshots
  ADD COLUMN IF NOT EXISTS stale_account_count INTEGER NOT NULL DEFAULT 0;
