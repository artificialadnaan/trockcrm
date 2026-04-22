-- Migration 0029: AI manager alerts
-- Adds manager alert persistence to existing tenant schemas and exposes a
-- tenant DDL section for new office provisioning.

DO $$ BEGIN
  CREATE TYPE ai_manager_alert_snapshot_mode AS ENUM ('preview', 'sent');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'manager_alert_summary';
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
      'CREATE TABLE IF NOT EXISTS %I.ai_manager_alert_snapshots (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         office_id UUID NOT NULL REFERENCES public.offices(id),
         snapshot_kind VARCHAR(80) NOT NULL,
         snapshot_mode ai_manager_alert_snapshot_mode NOT NULL DEFAULT ''preview'',
         snapshot_json JSONB NOT NULL DEFAULT ''{}''::jsonb,
         scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         sent_at TIMESTAMPTZ,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )',
      schema_name
    );

    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS ai_manager_alert_snapshots_office_id_snapshot_kind_uidx
       ON %I.ai_manager_alert_snapshots (office_id, snapshot_kind)',
      schema_name
    );

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.ai_manager_alert_send_ledger (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         office_id UUID NOT NULL REFERENCES public.offices(id),
         recipient_user_id UUID NOT NULL REFERENCES public.users(id),
         summary_type notification_type NOT NULL,
         office_local_date DATE NOT NULL,
         claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )',
      schema_name
    );

    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS ai_manager_alert_send_ledger_office_id_recipient_user_id_summary_type_office_local_date_uidx
       ON %I.ai_manager_alert_send_ledger (office_id, recipient_user_id, summary_type, office_local_date)',
      schema_name
    );
  END LOOP;
END $$;

-- TENANT_SCHEMA_START
DO $tenant$
BEGIN
  CREATE TABLE IF NOT EXISTS ai_manager_alert_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    office_id UUID NOT NULL REFERENCES public.offices(id),
    snapshot_kind VARCHAR(80) NOT NULL,
    snapshot_mode ai_manager_alert_snapshot_mode NOT NULL DEFAULT 'preview',
    snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE UNIQUE INDEX IF NOT EXISTS ai_manager_alert_snapshots_office_id_snapshot_kind_uidx
    ON ai_manager_alert_snapshots (office_id, snapshot_kind);

  CREATE TABLE IF NOT EXISTS ai_manager_alert_send_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    office_id UUID NOT NULL REFERENCES public.offices(id),
    recipient_user_id UUID NOT NULL REFERENCES public.users(id),
    summary_type notification_type NOT NULL,
    office_local_date DATE NOT NULL,
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE UNIQUE INDEX IF NOT EXISTS ai_manager_alert_send_ledger_office_id_recipient_user_id_summary_type_office_local_date_uidx
    ON ai_manager_alert_send_ledger (office_id, recipient_user_id, summary_type, office_local_date);
END $tenant$;
-- TENANT_SCHEMA_END
