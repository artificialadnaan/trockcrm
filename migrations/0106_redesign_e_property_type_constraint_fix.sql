-- Redesign E hotfix: repair property_type canonical value and replay Phase 1
-- schema additions for future tenant provisioning.

DO $$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT nspname
      FROM pg_namespace
     WHERE nspname LIKE 'office\_%' ESCAPE '\'
  LOOP
    IF to_regclass(format('%I.companies', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I.companies
           ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
           ADD COLUMN IF NOT EXISTS region text,
           ADD COLUMN IF NOT EXISTS domain text,
           ADD COLUMN IF NOT EXISTS hubspot_company_id text',
        tenant_schema
      );

      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS companies_owner_user_idx
           ON %I.companies(owner_user_id)
         WHERE owner_user_id IS NOT NULL',
        tenant_schema
      );
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS companies_region_idx
           ON %I.companies(region)
         WHERE region IS NOT NULL',
        tenant_schema
      );
    END IF;

    IF to_regclass(format('%I.properties', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I.properties
           ADD COLUMN IF NOT EXISTS property_type text,
           ADD COLUMN IF NOT EXISTS procore_property_id text,
           ADD COLUMN IF NOT EXISTS companycam_project_id text,
           ADD COLUMN IF NOT EXISTS hubspot_property_id text',
        tenant_schema
      );

      EXECUTE format(
        'ALTER TABLE %I.properties DROP CONSTRAINT IF EXISTS properties_property_type_check',
        tenant_schema
      );
      EXECUTE format(
        'ALTER TABLE %I.properties
           ADD CONSTRAINT properties_property_type_check CHECK (
             property_type IS NULL OR property_type IN
             (''school'', ''office'', ''industrial'', ''retail'', ''healthcare'', ''government'', ''mixed_use'')
           )',
        tenant_schema
      );
    END IF;
  END LOOP;
END $$;

-- TENANT_SCHEMA_START
DO $tenant$
BEGIN
  IF to_regclass('companies') IS NULL OR to_regclass('properties') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE companies ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL;
  ALTER TABLE companies ADD COLUMN IF NOT EXISTS region text;
  ALTER TABLE companies ADD COLUMN IF NOT EXISTS domain text;
  ALTER TABLE companies ADD COLUMN IF NOT EXISTS hubspot_company_id text;

  CREATE INDEX IF NOT EXISTS companies_owner_user_idx
    ON companies(owner_user_id)
    WHERE owner_user_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS companies_region_idx
    ON companies(region)
    WHERE region IS NOT NULL;

  ALTER TABLE properties ADD COLUMN IF NOT EXISTS property_type text;
  ALTER TABLE properties ADD COLUMN IF NOT EXISTS procore_property_id text;
  ALTER TABLE properties ADD COLUMN IF NOT EXISTS companycam_project_id text;
  ALTER TABLE properties ADD COLUMN IF NOT EXISTS hubspot_property_id text;

  ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_property_type_check;
  ALTER TABLE properties ADD CONSTRAINT properties_property_type_check CHECK (
    property_type IS NULL OR property_type IN
    ('school', 'office', 'industrial', 'retail', 'healthcare', 'government', 'mixed_use')
  );
END
$tenant$;
-- TENANT_SCHEMA_END
