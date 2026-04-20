-- Migration 0030: Add estimating document parse runs and lifecycle metadata

CREATE TABLE IF NOT EXISTS public.estimate_document_parse_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES public.estimate_source_documents(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued',
  parse_profile TEXT,
  parse_provider TEXT,
  error_summary TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS estimate_document_parse_runs_document_idx
  ON public.estimate_document_parse_runs (document_id, started_at);

ALTER TABLE public.estimate_source_documents
  ADD COLUMN IF NOT EXISTS parse_status TEXT NOT NULL DEFAULT 'queued',
  ADD COLUMN IF NOT EXISTS active_parse_run_id UUID,
  ADD COLUMN IF NOT EXISTS parse_profile TEXT,
  ADD COLUMN IF NOT EXISTS parse_provider TEXT,
  ADD COLUMN IF NOT EXISTS parse_error_summary TEXT;

DO $$
BEGIN
  ALTER TABLE public.estimate_source_documents
    DROP CONSTRAINT IF EXISTS estimate_source_documents_active_parse_run_id_fkey;
  ALTER TABLE public.estimate_source_documents
    ADD CONSTRAINT estimate_source_documents_active_parse_run_id_fkey
    FOREIGN KEY (active_parse_run_id) REFERENCES public.estimate_document_parse_runs(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

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
  END LOOP;
END $$;
