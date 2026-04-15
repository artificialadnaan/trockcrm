-- Migration 0021: Activity and email attribution expansion
-- Applies the activity attribution schema changes to every existing tenant
-- schema and exposes a guarded tenant DDL section for new office provisioning.

DO $$
DECLARE
  tenant_schema TEXT;
  tenant_sql TEXT := $tenant_migration$
DO $tenant$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name = 'activities'
  ) THEN
    BEGIN
      CREATE TYPE activity_source_entity AS ENUM (
        'company',
        'property',
        'lead',
        'deal',
        'contact'
      );
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END;

    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'activities'
        AND column_name = 'user_id'
    ) THEN
      ALTER TABLE activities RENAME COLUMN user_id TO responsible_user_id;
    END IF;

    ALTER TABLE activities
      ADD COLUMN IF NOT EXISTS performed_by_user_id UUID REFERENCES public.users(id),
      ADD COLUMN IF NOT EXISTS source_entity_type activity_source_entity,
      ADD COLUMN IF NOT EXISTS source_entity_id UUID,
      ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id),
      ADD COLUMN IF NOT EXISTS property_id UUID REFERENCES properties(id),
      ADD COLUMN IF NOT EXISTS lead_id UUID REFERENCES leads(id);

    UPDATE activities
    SET
      source_entity_type = CASE
        WHEN deal_id IS NOT NULL THEN 'deal'::activity_source_entity
        WHEN contact_id IS NOT NULL THEN 'contact'::activity_source_entity
        ELSE COALESCE(source_entity_type, 'contact'::activity_source_entity)
      END,
      source_entity_id = COALESCE(source_entity_id, deal_id, contact_id),
      company_id = COALESCE(company_id, NULL),
      property_id = COALESCE(property_id, NULL),
      lead_id = COALESCE(lead_id, NULL)
    WHERE source_entity_type IS NULL
       OR source_entity_id IS NULL;

    ALTER TABLE activities
      ALTER COLUMN responsible_user_id SET NOT NULL,
      ALTER COLUMN source_entity_type SET NOT NULL,
      ALTER COLUMN source_entity_id SET NOT NULL;

    DROP INDEX IF EXISTS activities_user_idx;

    CREATE INDEX IF NOT EXISTS activities_responsible_user_idx
      ON activities (responsible_user_id, occurred_at);

    CREATE INDEX IF NOT EXISTS activities_company_idx
      ON activities (company_id, occurred_at);

    CREATE INDEX IF NOT EXISTS activities_property_idx
      ON activities (property_id, occurred_at);

    CREATE INDEX IF NOT EXISTS activities_lead_idx
      ON activities (lead_id, occurred_at);
  END IF;
END $tenant$;
$tenant_migration$;
BEGIN
  FOR tenant_schema IN
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name LIKE 'office_%'
  LOOP
    EXECUTE format('SET LOCAL search_path = %I, public', tenant_schema);
    EXECUTE tenant_sql;
    RAISE NOTICE 'Applied activity attribution migration to schema: %', tenant_schema;
  END LOOP;
END $$;

-- TENANT_SCHEMA_START
DO $tenant$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name = 'activities'
  ) THEN
    BEGIN
      CREATE TYPE activity_source_entity AS ENUM (
        'company',
        'property',
        'lead',
        'deal',
        'contact'
      );
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END;

    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'activities'
        AND column_name = 'user_id'
    ) THEN
      ALTER TABLE activities RENAME COLUMN user_id TO responsible_user_id;
    END IF;

    ALTER TABLE activities
      ADD COLUMN IF NOT EXISTS performed_by_user_id UUID REFERENCES public.users(id),
      ADD COLUMN IF NOT EXISTS source_entity_type activity_source_entity,
      ADD COLUMN IF NOT EXISTS source_entity_id UUID,
      ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id),
      ADD COLUMN IF NOT EXISTS property_id UUID REFERENCES properties(id),
      ADD COLUMN IF NOT EXISTS lead_id UUID REFERENCES leads(id);

    UPDATE activities
    SET
      source_entity_type = CASE
        WHEN deal_id IS NOT NULL THEN 'deal'::activity_source_entity
        WHEN contact_id IS NOT NULL THEN 'contact'::activity_source_entity
        ELSE COALESCE(source_entity_type, 'contact'::activity_source_entity)
      END,
      source_entity_id = COALESCE(source_entity_id, deal_id, contact_id),
      company_id = COALESCE(company_id, NULL),
      property_id = COALESCE(property_id, NULL),
      lead_id = COALESCE(lead_id, NULL)
    WHERE source_entity_type IS NULL
       OR source_entity_id IS NULL;

    ALTER TABLE activities
      ALTER COLUMN responsible_user_id SET NOT NULL,
      ALTER COLUMN source_entity_type SET NOT NULL,
      ALTER COLUMN source_entity_id SET NOT NULL;

    DROP INDEX IF EXISTS activities_user_idx;

    CREATE INDEX IF NOT EXISTS activities_responsible_user_idx
      ON activities (responsible_user_id, occurred_at);

    CREATE INDEX IF NOT EXISTS activities_company_idx
      ON activities (company_id, occurred_at);

    CREATE INDEX IF NOT EXISTS activities_property_idx
      ON activities (property_id, occurred_at);

    CREATE INDEX IF NOT EXISTS activities_lead_idx
      ON activities (lead_id, occurred_at);
  END IF;
END $tenant$;
-- TENANT_SCHEMA_END
