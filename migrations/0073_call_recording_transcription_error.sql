DO $$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name LIKE 'office_%'
  LOOP
    IF EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = schema_name
        AND table_name = 'call_recordings'
    ) THEN
      EXECUTE format('ALTER TABLE %I.call_recordings ADD COLUMN IF NOT EXISTS transcription_error text', schema_name);
    END IF;
  END LOOP;
END $$;
