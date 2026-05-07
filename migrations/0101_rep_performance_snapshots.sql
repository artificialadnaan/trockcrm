DO $$
BEGIN
  CREATE TYPE perf_period_kind AS ENUM (
    'mtd',
    'qtd',
    'ytd',
    'last_month',
    'last_quarter',
    'last_year',
    'week_8back'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS rep_performance_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id UUID NOT NULL REFERENCES users(id),
  period_kind perf_period_kind NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  pipeline_value NUMERIC(14, 2) NOT NULL DEFAULT 0,
  closed_value NUMERIC(14, 2) NOT NULL DEFAULT 0,
  deals_count INTEGER NOT NULL DEFAULT 0,
  wins_count INTEGER NOT NULL DEFAULT 0,
  losses_count INTEGER NOT NULL DEFAULT 0,
  win_rate NUMERIC(5, 2) NOT NULL DEFAULT 0,
  at_risk_count INTEGER NOT NULL DEFAULT 0,
  activity_total INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  emails INTEGER NOT NULL DEFAULT 0,
  meetings INTEGER NOT NULL DEFAULT 0,
  notes INTEGER NOT NULL DEFAULT 0,
  sparkline_8w JSONB NOT NULL DEFAULT '[]'::jsonb,
  region TEXT,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS rep_performance_snapshots_rep_period_idx
  ON rep_performance_snapshots (rep_id, period_kind, period_start);
