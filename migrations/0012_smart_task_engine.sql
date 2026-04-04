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

ALTER TABLE tasks
  ADD CONSTRAINT tasks_office_id_offices_id_fk FOREIGN KEY (office_id) REFERENCES offices(id);

CREATE INDEX IF NOT EXISTS tasks_status_scheduled_for_idx
  ON tasks (status, scheduled_for);

CREATE UNIQUE INDEX IF NOT EXISTS tasks_active_origin_rule_dedupe_key_uidx
  ON tasks (origin_rule, dedupe_key)
  WHERE origin_rule IS NOT NULL
    AND dedupe_key IS NOT NULL
    AND status IN ('scheduled', 'pending', 'in_progress', 'waiting_on', 'blocked');

CREATE INDEX IF NOT EXISTS tasks_origin_rule_reason_code_idx
  ON tasks (origin_rule, reason_code);

DO $$ BEGIN
  CREATE TYPE task_resolution_status AS ENUM ('completed', 'dismissed', 'suppressed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS task_resolution_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  office_id UUID NOT NULL REFERENCES offices(id),
  task_id UUID NOT NULL,
  origin_rule VARCHAR(120) NOT NULL,
  dedupe_key VARCHAR(255) NOT NULL,
  resolution_status VARCHAR(50) NOT NULL,
  resolution_reason VARCHAR(120),
  resolved_at TIMESTAMPTZ,
  suppressed_until TIMESTAMPTZ,
  entity_snapshot JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS task_resolution_state_origin_rule_dedupe_key_uidx
  ON task_resolution_state (origin_rule, dedupe_key);

CREATE INDEX IF NOT EXISTS task_resolution_state_reason_code_idx
  ON task_resolution_state (resolution_reason);
