-- A4 reports scheduling and run history.
-- Extends public.saved_reports; does not create a parallel reports table.

DO $$ BEGIN
  CREATE TYPE report_frequency AS ENUM ('daily', 'weekly', 'biweekly', 'monthly', 'quarterly');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE report_run_status AS ENUM ('queued', 'running', 'succeeded', 'failed', 'not_implemented');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS report_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id UUID NOT NULL REFERENCES saved_reports(id) ON DELETE CASCADE,
  frequency report_frequency NOT NULL,
  cron_expr TEXT NOT NULL,
  recipients JSONB NOT NULL DEFAULT '[]'::jsonb,
  next_run_at TIMESTAMPTZ NOT NULL,
  last_run_at TIMESTAMPTZ,
  owner_id UUID NOT NULL REFERENCES users(id),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS report_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id UUID NOT NULL REFERENCES saved_reports(id) ON DELETE CASCADE,
  schedule_id UUID REFERENCES report_schedules(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  status report_run_status NOT NULL DEFAULT 'queued',
  result_uri TEXT,
  error TEXT,
  runtime_ms INTEGER
);

CREATE INDEX IF NOT EXISTS report_schedules_report_idx
  ON report_schedules (report_id);

CREATE INDEX IF NOT EXISTS report_schedules_owner_idx
  ON report_schedules (owner_id);

CREATE INDEX IF NOT EXISTS report_schedules_due_idx
  ON report_schedules (is_active, next_run_at);

CREATE INDEX IF NOT EXISTS report_runs_report_idx
  ON report_runs (report_id);

CREATE INDEX IF NOT EXISTS report_runs_schedule_idx
  ON report_runs (schedule_id);

CREATE INDEX IF NOT EXISTS report_runs_status_idx
  ON report_runs (status, started_at);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'set_report_schedules_updated_at'
  ) THEN
    CREATE TRIGGER set_report_schedules_updated_at
      BEFORE UPDATE ON report_schedules
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;
