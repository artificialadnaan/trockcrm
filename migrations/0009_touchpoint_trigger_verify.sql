-- Migration 0009: Verify touchpoint trigger + backfill counts
-- For each office_* schema: ensures the touchpoint trigger exists on activities,
-- creates it if missing (idempotent), and backfills touchpoint_count where stale.

DO $$
DECLARE
  tenant_schema TEXT;
BEGIN
  FOR tenant_schema IN
    SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'office_%'
  LOOP
    -- Create or replace the trigger function in this tenant schema
    EXECUTE format('
      CREATE OR REPLACE FUNCTION %I.increment_touchpoint_count()
      RETURNS TRIGGER AS $fn$
      BEGIN
        IF NEW.contact_id IS NOT NULL AND NEW.type IN (''call'', ''email'', ''meeting'') THEN
          UPDATE %I.contacts
          SET touchpoint_count = touchpoint_count + 1,
              last_contacted_at = NEW.occurred_at,
              first_outreach_completed = TRUE
          WHERE id = NEW.contact_id;
        END IF;
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql;
    ', tenant_schema, tenant_schema);

    -- Create the trigger only if it does not already exist
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.triggers
      WHERE trigger_schema = tenant_schema
        AND event_object_table = 'activities'
        AND trigger_name = 'touchpoint_trigger'
    ) THEN
      EXECUTE format('
        CREATE TRIGGER touchpoint_trigger
          AFTER INSERT ON %I.activities
          FOR EACH ROW EXECUTE FUNCTION %I.increment_touchpoint_count()
      ', tenant_schema, tenant_schema);

      RAISE NOTICE 'Created touchpoint_trigger in schema: %', tenant_schema;
    ELSE
      RAISE NOTICE 'touchpoint_trigger already exists in schema: %', tenant_schema;
    END IF;

    -- Backfill touchpoint_count from actual activity counts for call/email/meeting
    EXECUTE format('
      UPDATE %I.contacts c
      SET touchpoint_count = COALESCE(sub.cnt, 0)
      FROM (
        SELECT contact_id, COUNT(*) AS cnt
        FROM %I.activities
        WHERE contact_id IS NOT NULL
          AND type IN (''call'', ''email'', ''meeting'')
        GROUP BY contact_id
      ) sub
      WHERE c.id = sub.contact_id
        AND c.touchpoint_count != COALESCE(sub.cnt, 0)
    ', tenant_schema, tenant_schema);

    RAISE NOTICE 'Backfilled touchpoint_count in schema: %', tenant_schema;
  END LOOP;
END $$;
