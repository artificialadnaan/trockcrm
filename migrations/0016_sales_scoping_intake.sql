-- Migration 0016: sales scoping intake schema
-- Adds canonical workflow routing plus deal scoping intake storage across tenant schemas.

DO $$
DECLARE
  tenant_schema TEXT;
  has_null_deal_id BOOLEAN;
  has_null_office_id BOOLEAN;
  has_null_created_by BOOLEAN;
  has_null_last_edited_by BOOLEAN;
  invalid_required_columns TEXT[];
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

    EXECUTE format(
      'ALTER TYPE %I.workflow_route ADD VALUE IF NOT EXISTS ''estimating''',
      tenant_schema
    );
    EXECUTE format(
      'ALTER TYPE %I.workflow_route ADD VALUE IF NOT EXISTS ''service''',
      tenant_schema
    );

    BEGIN
      EXECUTE format(
        'CREATE TYPE %I.deal_scoping_intake_status AS ENUM (''draft'', ''ready'', ''activated'')',
        tenant_schema
      );
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END;

    EXECUTE format(
      'ALTER TYPE %I.deal_scoping_intake_status ADD VALUE IF NOT EXISTS ''draft''',
      tenant_schema
    );
    EXECUTE format(
      'ALTER TYPE %I.deal_scoping_intake_status ADD VALUE IF NOT EXISTS ''ready''',
      tenant_schema
    );
    EXECUTE format(
      'ALTER TYPE %I.deal_scoping_intake_status ADD VALUE IF NOT EXISTS ''activated''',
      tenant_schema
    );

    EXECUTE format(
      'ALTER TABLE %I.deals
         ADD COLUMN IF NOT EXISTS workflow_route %I.workflow_route',
      tenant_schema,
      tenant_schema
    );
    EXECUTE format(
      'ALTER TABLE %I.deals
         ALTER COLUMN workflow_route SET DEFAULT ''estimating''',
      tenant_schema
    );
    EXECUTE format(
      'ALTER TABLE %I.deals DISABLE TRIGGER USER',
      tenant_schema
    );
    EXECUTE format(
      'UPDATE %I.deals
          SET workflow_route = ''estimating''
        WHERE workflow_route IS NULL',
      tenant_schema
    );
    EXECUTE format(
      'ALTER TABLE %I.deals ENABLE TRIGGER USER',
      tenant_schema
    );
    EXECUTE format(
      'ALTER TABLE %I.deals
         ALTER COLUMN workflow_route SET NOT NULL',
      tenant_schema
    );

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.deal_scoping_intake (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid()
       )',
      tenant_schema
    );

    EXECUTE format(
      'ALTER TABLE %I.deal_scoping_intake
         ADD COLUMN IF NOT EXISTS deal_id UUID,
         ADD COLUMN IF NOT EXISTS office_id UUID,
         ADD COLUMN IF NOT EXISTS workflow_route_snapshot %I.workflow_route,
         ADD COLUMN IF NOT EXISTS status %I.deal_scoping_intake_status,
         ADD COLUMN IF NOT EXISTS project_type_id UUID,
         ADD COLUMN IF NOT EXISTS section_data JSONB,
         ADD COLUMN IF NOT EXISTS completion_state JSONB,
         ADD COLUMN IF NOT EXISTS readiness_errors JSONB,
         ADD COLUMN IF NOT EXISTS first_ready_at TIMESTAMPTZ,
         ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ,
         ADD COLUMN IF NOT EXISTS last_autosaved_at TIMESTAMPTZ,
         ADD COLUMN IF NOT EXISTS created_by UUID,
         ADD COLUMN IF NOT EXISTS last_edited_by UUID,
         ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ,
         ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ',
      tenant_schema,
      tenant_schema,
      tenant_schema
    );

    EXECUTE format(
      'ALTER TABLE %I.deal_scoping_intake
         ALTER COLUMN id SET DEFAULT gen_random_uuid(),
         ALTER COLUMN status SET DEFAULT ''draft'',
         ALTER COLUMN section_data SET DEFAULT ''{}''::jsonb,
         ALTER COLUMN completion_state SET DEFAULT ''{}''::jsonb,
         ALTER COLUMN readiness_errors SET DEFAULT ''{}''::jsonb,
         ALTER COLUMN last_autosaved_at SET DEFAULT NOW(),
         ALTER COLUMN created_at SET DEFAULT NOW(),
         ALTER COLUMN updated_at SET DEFAULT NOW()',
      tenant_schema
    );
    EXECUTE format(
      'UPDATE %I.deal_scoping_intake
          SET status = COALESCE(status, ''draft''),
              section_data = COALESCE(section_data, ''{}''::jsonb),
              completion_state = COALESCE(completion_state, ''{}''::jsonb),
              readiness_errors = COALESCE(readiness_errors, ''{}''::jsonb),
              last_autosaved_at = COALESCE(last_autosaved_at, NOW()),
              created_at = COALESCE(created_at, NOW()),
              updated_at = COALESCE(updated_at, NOW()),
              workflow_route_snapshot = COALESCE(workflow_route_snapshot, ''estimating'')',
      tenant_schema
    );

    EXECUTE format(
      'SELECT EXISTS (
         SELECT 1
         FROM %I.deal_scoping_intake
         WHERE deal_id IS NULL
       )',
      tenant_schema
    ) INTO has_null_deal_id;
    EXECUTE format(
      'SELECT EXISTS (
         SELECT 1
         FROM %I.deal_scoping_intake
         WHERE office_id IS NULL
       )',
      tenant_schema
    ) INTO has_null_office_id;
    EXECUTE format(
      'SELECT EXISTS (
         SELECT 1
         FROM %I.deal_scoping_intake
         WHERE created_by IS NULL
       )',
      tenant_schema
    ) INTO has_null_created_by;
    EXECUTE format(
      'SELECT EXISTS (
         SELECT 1
         FROM %I.deal_scoping_intake
         WHERE last_edited_by IS NULL
       )',
      tenant_schema
    ) INTO has_null_last_edited_by;

    invalid_required_columns := array_remove(
      ARRAY[
        CASE WHEN has_null_deal_id THEN 'deal_id' END,
        CASE WHEN has_null_office_id THEN 'office_id' END,
        CASE WHEN has_null_created_by THEN 'created_by' END,
        CASE WHEN has_null_last_edited_by THEN 'last_edited_by' END
      ],
      NULL
    );

    IF array_length(invalid_required_columns, 1) IS NOT NULL THEN
      RAISE EXCEPTION
        'Migration 0016 cannot enforce deal_scoping_intake constraints for schema % because existing rows have NULL values in required columns: %. Backfill these columns before rerunning this migration.',
        tenant_schema,
        array_to_string(invalid_required_columns, ', ');
    END IF;

    EXECUTE format(
      'ALTER TABLE %I.deal_scoping_intake
         ALTER COLUMN deal_id SET NOT NULL,
         ALTER COLUMN office_id SET NOT NULL,
         ALTER COLUMN workflow_route_snapshot SET NOT NULL,
         ALTER COLUMN status SET NOT NULL,
         ALTER COLUMN section_data SET NOT NULL,
         ALTER COLUMN completion_state SET NOT NULL,
         ALTER COLUMN readiness_errors SET NOT NULL,
         ALTER COLUMN last_autosaved_at SET NOT NULL,
         ALTER COLUMN created_by SET NOT NULL,
         ALTER COLUMN last_edited_by SET NOT NULL,
         ALTER COLUMN created_at SET NOT NULL,
         ALTER COLUMN updated_at SET NOT NULL',
      tenant_schema
    );

    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS deal_scoping_intake_deal_id_uidx
         ON %I.deal_scoping_intake (deal_id)',
      tenant_schema
    );

    BEGIN
      EXECUTE format(
        'ALTER TABLE %I.deal_scoping_intake
           ADD CONSTRAINT deal_scoping_intake_deal_id_deals_id_fk
           FOREIGN KEY (deal_id) REFERENCES %I.deals(id)',
        tenant_schema,
        tenant_schema
      );
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END;

    BEGIN
      EXECUTE format(
        'ALTER TABLE %I.deal_scoping_intake
           ADD CONSTRAINT deal_scoping_intake_office_id_offices_id_fk
           FOREIGN KEY (office_id) REFERENCES public.offices(id)',
        tenant_schema
      );
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END;

    BEGIN
      EXECUTE format(
        'ALTER TABLE %I.deal_scoping_intake
           ADD CONSTRAINT deal_scoping_intake_project_type_id_project_type_config_id_fk
           FOREIGN KEY (project_type_id) REFERENCES public.project_type_config(id)',
        tenant_schema
      );
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END;

    BEGIN
      EXECUTE format(
        'ALTER TABLE %I.deal_scoping_intake
           ADD CONSTRAINT deal_scoping_intake_created_by_users_id_fk
           FOREIGN KEY (created_by) REFERENCES public.users(id)',
        tenant_schema
      );
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END;

    BEGIN
      EXECUTE format(
        'ALTER TABLE %I.deal_scoping_intake
           ADD CONSTRAINT deal_scoping_intake_last_edited_by_users_id_fk
           FOREIGN KEY (last_edited_by) REFERENCES public.users(id)',
        tenant_schema
      );
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END;

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
