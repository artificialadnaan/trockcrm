-- Preserve intended month-day for monthly and quarterly report schedules.

ALTER TABLE report_schedules
  ADD COLUMN IF NOT EXISTS anchor_day INTEGER;

UPDATE report_schedules
SET anchor_day = EXTRACT(DAY FROM next_run_at AT TIME ZONE 'UTC')::int
WHERE anchor_day IS NULL
  AND next_run_at IS NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'report_schedules_anchor_day_range'
  ) THEN
    ALTER TABLE report_schedules
      ADD CONSTRAINT report_schedules_anchor_day_range
      CHECK (anchor_day IS NULL OR (anchor_day >= 1 AND anchor_day <= 31));
  END IF;
END $$;
