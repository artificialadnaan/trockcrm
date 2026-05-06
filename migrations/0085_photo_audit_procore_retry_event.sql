-- Add audit event for admin-requested manual Procore photo sync retries.
-- Idempotent across all tenant schemas.

DO $$
DECLARE
  tenant_schema TEXT;
BEGIN
  FOR tenant_schema IN
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name LIKE 'office\_%' ESCAPE '\'
  LOOP
    IF to_regtype(format('%I.photo_audit_event_type', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TYPE %I.photo_audit_event_type ADD VALUE IF NOT EXISTS ''procore_sync_retry_requested''',
        tenant_schema
      );
    END IF;
  END LOOP;
END $$;
