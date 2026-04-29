DO $$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT schemata.schema_name
    FROM information_schema.schemata AS schemata
    WHERE schemata.schema_name LIKE 'office\_%' ESCAPE '\'
  LOOP
    IF EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = tenant_schema
        AND table_name = 'call_recordings'
    ) THEN
      EXECUTE format('ALTER TABLE %I.call_recordings ADD COLUMN IF NOT EXISTS transcription_error text', tenant_schema);
    END IF;
  END LOOP;
END $$;
