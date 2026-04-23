-- Migration 0031: Repair estimating parse-run immutability for already-applied 0030 environments

CREATE OR REPLACE FUNCTION public.ensure_estimate_source_document_active_parse_run_matches()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  matched_run_id UUID;
BEGIN
  IF NEW.active_parse_run_id IS NULL THEN
    RETURN NEW;
  END IF;

  EXECUTE format(
    'SELECT id
       FROM %I.estimate_document_parse_runs
      WHERE id = $1
        AND document_id = $2',
    TG_TABLE_SCHEMA
  )
  INTO matched_run_id
  USING NEW.active_parse_run_id, NEW.id;

  IF matched_run_id IS NULL THEN
    RAISE EXCEPTION
      'active_parse_run_id % does not belong to document %',
      NEW.active_parse_run_id,
      NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

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
      'DROP TRIGGER IF EXISTS estimate_source_documents_validate_active_parse_run ON %I.estimate_source_documents',
      schema_name
    );
    EXECUTE format(
      'CREATE TRIGGER estimate_source_documents_validate_active_parse_run
         BEFORE INSERT OR UPDATE OF active_parse_run_id ON %I.estimate_source_documents
         FOR EACH ROW EXECUTE FUNCTION public.ensure_estimate_source_document_active_parse_run_matches()',
      schema_name
    );

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
