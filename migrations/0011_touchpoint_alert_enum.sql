-- Migration 0011: Add touchpoint_alert to notification_type enum
-- Uses exception handling pattern for PostgreSQL enum additions

DO $$
DECLARE
  tenant_schema TEXT;
BEGIN
  FOR tenant_schema IN
    SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'office_%'
  LOOP
    BEGIN
      EXECUTE format('ALTER TYPE %I.notification_type ADD VALUE ''touchpoint_alert''', tenant_schema);
    EXCEPTION WHEN duplicate_object THEN
      NULL; -- Already exists, skip
    END;
  END LOOP;
END $$;
