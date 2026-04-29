DO $$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname LIKE 'office\_%' ESCAPE '\'
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = schema_name AND table_name = 'deals') THEN
      EXECUTE format($sql$
        CREATE TABLE IF NOT EXISTS %I.call_recordings (
          id uuid PRIMARY KEY,
          tenant_id uuid NOT NULL REFERENCES public.offices(id),
          uploaded_by uuid NOT NULL REFERENCES public.users(id),
          uploaded_at timestamptz NOT NULL DEFAULT now(),

          entity_type text NOT NULL CHECK (entity_type IN ('deal', 'lead', 'company', 'contact')),
          entity_id uuid NOT NULL,

          original_filename text NOT NULL,
          r2_key text NOT NULL UNIQUE,
          mime_type text NOT NULL,
          file_size_bytes bigint NOT NULL,
          duration_seconds integer,

          title text,
          notes text,
          call_date timestamptz,

          expires_at timestamptz,
          deleted_at timestamptz,

          transcription_status text NOT NULL DEFAULT 'none' CHECK (transcription_status IN ('none', 'pending', 'processing', 'complete', 'failed')),
          transcript_text text,
          transcript_summary text
        )
      $sql$, schema_name);

      EXECUTE format('CREATE INDEX IF NOT EXISTS idx_call_recordings_entity ON %I.call_recordings(entity_type, entity_id) WHERE deleted_at IS NULL', schema_name);
      EXECUTE format('CREATE INDEX IF NOT EXISTS idx_call_recordings_expires ON %I.call_recordings(expires_at) WHERE deleted_at IS NULL', schema_name);
      EXECUTE format('CREATE INDEX IF NOT EXISTS idx_call_recordings_tenant ON %I.call_recordings(tenant_id, uploaded_at DESC) WHERE deleted_at IS NULL', schema_name);
    END IF;
  END LOOP;
END $$;
