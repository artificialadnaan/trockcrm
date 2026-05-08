ALTER TABLE rep_performance_snapshots
  ADD COLUMN IF NOT EXISTS avg_days_to_close NUMERIC(7, 2) NOT NULL DEFAULT 0;
