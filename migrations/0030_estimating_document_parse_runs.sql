-- Migration 0030: Add estimating document parse runs and lifecycle metadata

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
      'CREATE TABLE IF NOT EXISTS %I.estimate_document_parse_runs (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         document_id UUID NOT NULL REFERENCES %I.estimate_source_documents(id) ON DELETE CASCADE,
         status TEXT NOT NULL DEFAULT ''queued'',
         parse_profile TEXT,
         parse_provider TEXT,
         error_summary TEXT,
         started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         completed_at TIMESTAMPTZ,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )',
      schema_name,
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS estimate_document_parse_runs_document_idx
         ON %I.estimate_document_parse_runs (document_id, started_at)',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.estimate_source_documents
         ADD COLUMN IF NOT EXISTS parse_status TEXT NOT NULL DEFAULT ''queued'',
         ADD COLUMN IF NOT EXISTS active_parse_run_id UUID,
         ADD COLUMN IF NOT EXISTS parse_profile TEXT,
         ADD COLUMN IF NOT EXISTS parse_provider TEXT,
         ADD COLUMN IF NOT EXISTS parse_error_summary TEXT',
      schema_name
    );

    BEGIN
      EXECUTE format(
        'ALTER TABLE %I.estimate_source_documents
           DROP CONSTRAINT IF EXISTS estimate_source_documents_active_parse_run_id_fkey',
        schema_name
      );
      EXECUTE format(
        'ALTER TABLE %I.estimate_source_documents
           ADD CONSTRAINT estimate_source_documents_active_parse_run_id_fkey
           FOREIGN KEY (active_parse_run_id) REFERENCES %I.estimate_document_parse_runs(id) ON DELETE SET NULL',
        schema_name,
        schema_name
      );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;

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

-- TENANT_SCHEMA_START
-- Fresh office schemas need this replayed so the estimating parse lifecycle is provisioned automatically.

CREATE TABLE IF NOT EXISTS estimate_document_parse_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES estimate_source_documents(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued',
  parse_profile TEXT,
  parse_provider TEXT,
  error_summary TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS estimate_document_parse_runs_document_idx
  ON estimate_document_parse_runs (document_id, started_at);

ALTER TABLE estimate_source_documents
  ADD COLUMN IF NOT EXISTS parse_status TEXT NOT NULL DEFAULT 'queued',
  ADD COLUMN IF NOT EXISTS active_parse_run_id UUID REFERENCES estimate_document_parse_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS parse_profile TEXT,
  ADD COLUMN IF NOT EXISTS parse_provider TEXT,
  ADD COLUMN IF NOT EXISTS parse_error_summary TEXT;

DROP TRIGGER IF EXISTS estimate_source_documents_validate_active_parse_run ON estimate_source_documents;
CREATE TRIGGER estimate_source_documents_validate_active_parse_run
  BEFORE INSERT OR UPDATE OF active_parse_run_id ON estimate_source_documents
  FOR EACH ROW EXECUTE FUNCTION public.ensure_estimate_source_document_active_parse_run_matches();

DROP TRIGGER IF EXISTS estimate_document_parse_runs_document_immutable ON estimate_document_parse_runs;
CREATE TRIGGER estimate_document_parse_runs_document_immutable
  BEFORE UPDATE OF document_id ON estimate_document_parse_runs
  FOR EACH ROW EXECUTE FUNCTION public.ensure_estimate_document_parse_run_document_immutable();
-- TENANT_SCHEMA_END
