-- Email inbox reader actions and server-side inbox filtering support.

DO $$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT nspname
      FROM pg_namespace
     WHERE nspname LIKE 'office\_%' ESCAPE '\'
  LOOP
    IF to_regclass(format('%I.emails', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I.emails
           ADD COLUMN IF NOT EXISTS is_starred boolean NOT NULL DEFAULT false,
           ADD COLUMN IF NOT EXISTS archived_at timestamptz,
           ADD COLUMN IF NOT EXISTS deleted_at timestamptz',
        tenant_schema
      );

      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS emails_user_inbox_active_idx
           ON %I.emails(user_id, direction, sent_at DESC)
           WHERE archived_at IS NULL AND deleted_at IS NULL',
        tenant_schema
      );
    END IF;
  END LOOP;
END $$;

-- TENANT_SCHEMA_START
DO $tenant$
BEGIN
  IF to_regclass('emails') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE emails
    ADD COLUMN IF NOT EXISTS is_starred boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS archived_at timestamptz,
    ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

  CREATE INDEX IF NOT EXISTS emails_user_inbox_active_idx
    ON emails(user_id, direction, sent_at DESC)
    WHERE archived_at IS NULL AND deleted_at IS NULL;
END
$tenant$;
-- TENANT_SCHEMA_END
