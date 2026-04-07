-- Migration 0016: sales scoping intake schema
-- Adds canonical workflow routing plus deal scoping intake storage across tenant schemas.

DO $$
DECLARE
  tenant_schema TEXT;
BEGIN
  FOR tenant_schema IN
    SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'office_%'
  LOOP
    BEGIN
      EXECUTE format(
        'CREATE TYPE %I.workflow_route AS ENUM (''estimating'', ''service'')',
        tenant_schema
      );
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END;

    BEGIN
      EXECUTE format(
        'CREATE TYPE %I.deal_scoping_intake_status AS ENUM (''draft'', ''ready'', ''activated'')',
        tenant_schema
      );
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END;

    EXECUTE format(
      'ALTER TABLE %I.deals
         ADD COLUMN IF NOT EXISTS workflow_route %I.workflow_route NOT NULL DEFAULT ''estimating''',
      tenant_schema,
      tenant_schema
    );

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.deal_scoping_intake (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         deal_id UUID NOT NULL UNIQUE,
         office_id UUID NOT NULL,
         workflow_route_snapshot %I.workflow_route NOT NULL,
         status %I.deal_scoping_intake_status NOT NULL DEFAULT ''draft'',
         project_type_id UUID,
         section_data JSONB NOT NULL DEFAULT ''{}''::jsonb,
         completion_state JSONB NOT NULL DEFAULT ''{}''::jsonb,
         readiness_errors JSONB NOT NULL DEFAULT ''{}''::jsonb,
         first_ready_at TIMESTAMPTZ,
         activated_at TIMESTAMPTZ,
         last_autosaved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         created_by UUID NOT NULL,
         last_edited_by UUID NOT NULL,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )',
      tenant_schema,
      tenant_schema,
      tenant_schema
    );

    EXECUTE format(
      'ALTER TABLE %I.files
         ADD COLUMN IF NOT EXISTS intake_section VARCHAR(100),
         ADD COLUMN IF NOT EXISTS intake_requirement_key VARCHAR(100),
         ADD COLUMN IF NOT EXISTS intake_source VARCHAR(30)',
      tenant_schema
    );

    RAISE NOTICE 'Applied sales scoping intake migration to schema: %', tenant_schema;
  END LOOP;
END $$;
