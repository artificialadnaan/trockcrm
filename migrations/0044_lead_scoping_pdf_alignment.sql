DO $$
DECLARE
  tenant_schema TEXT;
BEGIN
  FOR tenant_schema IN
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name LIKE 'office\_%' ESCAPE '\'
      AND EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = schema_name
          AND table_name = 'leads'
      )
      AND EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = schema_name
          AND table_name = 'files'
      )
  LOOP
    BEGIN
      EXECUTE format(
        'CREATE TYPE %I.lead_scoping_intake_status AS ENUM (''draft'', ''ready'', ''completed'')',
        tenant_schema
      );
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END;

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %1$I.lead_scoping_intake (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         lead_id UUID NOT NULL REFERENCES %1$I.leads(id) ON DELETE CASCADE UNIQUE,
         office_id UUID NOT NULL REFERENCES public.offices(id),
         status %1$I.lead_scoping_intake_status NOT NULL DEFAULT ''draft'',
         section_data JSONB NOT NULL DEFAULT ''{}''::jsonb,
         completion_state JSONB NOT NULL DEFAULT ''{}''::jsonb,
         readiness_errors JSONB NOT NULL DEFAULT ''{}''::jsonb,
         first_ready_at TIMESTAMPTZ,
         completed_at TIMESTAMPTZ,
         last_autosaved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         created_by UUID NOT NULL REFERENCES public.users(id),
         last_edited_by UUID NOT NULL REFERENCES public.users(id),
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )',
      tenant_schema
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS lead_scoping_intake_office_id_idx
         ON %I.lead_scoping_intake(office_id, updated_at DESC)',
      tenant_schema
    );

    EXECUTE format(
      'ALTER TABLE %1$I.files
         ADD COLUMN IF NOT EXISTS lead_id UUID REFERENCES %1$I.leads(id)',
      tenant_schema
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS files_lead_idx
         ON %I.files(lead_id, category, created_at)',
      tenant_schema
    );
  END LOOP;
END $$;
