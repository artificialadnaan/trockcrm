-- Migration 0031: Repair estimating parse-run immutability for already-applied 0030 environments

CREATE OR REPLACE FUNCTION public.ensure_estimate_document_parse_run_document_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.document_id IS DISTINCT FROM OLD.document_id THEN
    RAISE EXCEPTION
      'document_id on estimate_document_parse_runs is immutable';
  END IF;

  RETURN NEW;
END;
$$;

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
      'DROP TRIGGER IF EXISTS estimate_document_parse_runs_document_immutable ON %I.estimate_document_parse_runs',
      schema_name
    );
    EXECUTE format(
      'CREATE TRIGGER estimate_document_parse_runs_document_immutable
         BEFORE UPDATE OF document_id ON %I.estimate_document_parse_runs
         FOR EACH ROW EXECUTE FUNCTION public.ensure_estimate_document_parse_run_document_immutable()',
      schema_name
    );
  END LOOP;
END $$;
