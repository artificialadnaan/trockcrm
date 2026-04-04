ALTER TYPE task_status ADD VALUE IF NOT EXISTS 'scheduled';
ALTER TYPE task_status ADD VALUE IF NOT EXISTS 'waiting_on';
ALTER TYPE task_status ADD VALUE IF NOT EXISTS 'blocked';

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS office_id uuid,
  ADD COLUMN IF NOT EXISTS origin_rule varchar(120),
  ADD COLUMN IF NOT EXISTS source_rule varchar(120),
  ADD COLUMN IF NOT EXISTS source_event varchar(120),
  ADD COLUMN IF NOT EXISTS dedupe_key varchar(255),
  ADD COLUMN IF NOT EXISTS reason_code varchar(120),
  ADD COLUMN IF NOT EXISTS entity_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS scheduled_for timestamptz,
  ADD COLUMN IF NOT EXISTS waiting_on jsonb,
  ADD COLUMN IF NOT EXISTS blocked_by jsonb,
  ADD COLUMN IF NOT EXISTS started_at timestamptz;

CREATE INDEX IF NOT EXISTS tasks_status_scheduled_for_idx
  ON tasks (status, scheduled_for);

CREATE INDEX IF NOT EXISTS tasks_origin_rule_dedupe_key_idx
  ON tasks (origin_rule, dedupe_key);

CREATE TABLE IF NOT EXISTS task_resolution_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL UNIQUE,
  origin_rule VARCHAR(120) NOT NULL,
  dedupe_key VARCHAR(255) NOT NULL,
  resolution VARCHAR(50) NOT NULL,
  reason_code VARCHAR(120),
  details JSONB,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS task_resolution_state_origin_rule_dedupe_key_idx
  ON task_resolution_state (origin_rule, dedupe_key);
