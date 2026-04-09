-- Migration 0018: Performance indexes for high-traffic query patterns

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
      'CREATE INDEX IF NOT EXISTS deals_active_stage_idx
         ON %I.deals (is_active, stage_id, updated_at DESC)',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS deals_assigned_rep_idx
         ON %I.deals (assigned_rep_id)
         WHERE is_active = TRUE',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS deals_expected_close_date_idx
         ON %I.deals (expected_close_date)
         WHERE is_active = TRUE AND expected_close_date IS NOT NULL',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS contacts_email_idx
         ON %I.contacts (email)
         WHERE email IS NOT NULL',
      schema_name
    );
  END LOOP;
END $$;
