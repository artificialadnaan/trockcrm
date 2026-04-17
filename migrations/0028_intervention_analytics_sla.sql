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
      'ALTER TABLE %I.ai_disconnect_cases
         ADD COLUMN IF NOT EXISTS current_lifecycle_started_at timestamptz,
         ADD COLUMN IF NOT EXISTS last_reopened_at timestamptz',
      schema_name
    );

    EXECUTE format(
      'UPDATE %I.ai_disconnect_cases
       SET
         current_lifecycle_started_at = COALESCE(current_lifecycle_started_at, first_detected_at, created_at),
         last_reopened_at = last_reopened_at',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.ai_disconnect_cases
         ALTER COLUMN current_lifecycle_started_at SET NOT NULL',
      schema_name
    );
  END LOOP;
END $$;
