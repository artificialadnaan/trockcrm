-- Migration 0032: Persist estimating measurement parse options on documents and parse runs

DO $$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT schemata.schema_name
    FROM information_schema.schemata AS schemata
    WHERE schemata.schema_name LIKE 'office_%'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.estimate_source_documents
         ADD COLUMN IF NOT EXISTS parse_measurements_enabled BOOLEAN NOT NULL DEFAULT false',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.estimate_document_parse_runs
         ADD COLUMN IF NOT EXISTS parse_measurements_enabled BOOLEAN NOT NULL DEFAULT false',
      schema_name
    );
  END LOOP;
END $$;

-- TENANT_SCHEMA_START
DO $tenant$
BEGIN
  IF to_regclass('estimate_source_documents') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE estimate_source_documents
    ADD COLUMN IF NOT EXISTS parse_measurements_enabled BOOLEAN NOT NULL DEFAULT false;

  ALTER TABLE estimate_document_parse_runs
    ADD COLUMN IF NOT EXISTS parse_measurements_enabled BOOLEAN NOT NULL DEFAULT false;
END
$tenant$;
-- TENANT_SCHEMA_END
