ALTER TYPE task_status ADD VALUE IF NOT EXISTS 'scheduled';
ALTER TYPE task_status ADD VALUE IF NOT EXISTS 'waiting_on';
ALTER TYPE task_status ADD VALUE IF NOT EXISTS 'blocked';

DO $$ BEGIN
  CREATE TYPE task_resolution_status AS ENUM ('completed', 'dismissed', 'suppressed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname LIKE 'office\_%' ESCAPE '\'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.tasks
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
         ADD COLUMN IF NOT EXISTS started_at timestamptz',
      schema_name
    );

    BEGIN
      EXECUTE format(
        'ALTER TABLE %I.tasks
           ADD CONSTRAINT tasks_office_id_offices_id_fk
           FOREIGN KEY (office_id) REFERENCES public.offices(id)',
        schema_name
      );
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END;

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS tasks_status_scheduled_for_idx
         ON %I.tasks (status, scheduled_for)',
      schema_name
    );

    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS tasks_active_origin_rule_dedupe_key_uidx
         ON %I.tasks (origin_rule, dedupe_key)
         WHERE origin_rule IS NOT NULL
           AND dedupe_key IS NOT NULL
           AND status IN (''scheduled'', ''pending'', ''in_progress'', ''waiting_on'', ''blocked'')',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS tasks_origin_rule_reason_code_idx
         ON %I.tasks (origin_rule, reason_code)',
      schema_name
    );

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.task_resolution_state (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         office_id UUID NOT NULL REFERENCES public.offices(id),
         task_id UUID NOT NULL,
         origin_rule VARCHAR(120) NOT NULL,
         dedupe_key VARCHAR(255) NOT NULL,
         resolution_status task_resolution_status NOT NULL,
         resolution_reason VARCHAR(120),
         resolved_at TIMESTAMPTZ,
         suppressed_until TIMESTAMPTZ,
         entity_snapshot JSONB,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )',
      schema_name
    );

    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS task_resolution_state_origin_rule_dedupe_key_uidx
         ON %I.task_resolution_state (origin_rule, dedupe_key)',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS task_resolution_state_reason_code_idx
         ON %I.task_resolution_state (resolution_reason)',
      schema_name
    );
  END LOOP;
END $$;
