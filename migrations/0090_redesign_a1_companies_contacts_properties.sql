-- Redesign A1: Tier 1 CRM list/detail fields for companies, contacts, and properties.
-- Idempotent for already-provisioned tenant schemas and replayable for future tenant schemas.

DO $$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT nspname
      FROM pg_namespace
     WHERE nspname LIKE 'office\_%' ESCAPE '\'
  LOOP
    IF to_regclass(format('%I.companies', tenant_schema)) IS NULL THEN
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = tenant_schema
         AND t.typname = 'company_industry'
    ) THEN
      EXECUTE format(
        'CREATE TYPE %I.company_industry AS ENUM (%L, %L, %L, %L, %L, %L, %L)',
        tenant_schema,
        'school_district',
        'healthcare',
        'industrial',
        'office_mixed',
        'retail',
        'government',
        'hospitality'
      );
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = tenant_schema
         AND t.typname = 'contact_role'
    ) THEN
      EXECUTE format(
        'CREATE TYPE %I.contact_role AS ENUM (%L, %L, %L, %L, %L, %L)',
        tenant_schema,
        'decision_maker',
        'influencer',
        'gatekeeper',
        'procurement',
        'engineer',
        'owner'
      );
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = tenant_schema
         AND t.typname = 'property_type'
    ) THEN
      EXECUTE format(
        'CREATE TYPE %I.property_type AS ENUM (%L, %L, %L, %L, %L, %L, %L)',
        tenant_schema,
        'office',
        'industrial',
        'retail',
        'school',
        'healthcare',
        'government',
        'mixed_use'
      );
    END IF;

    EXECUTE format('ALTER TABLE %I.companies ADD COLUMN IF NOT EXISTS industry %I.company_industry', tenant_schema, tenant_schema);
    EXECUTE format('ALTER TABLE %I.companies ADD COLUMN IF NOT EXISTS region text', tenant_schema);
    EXECUTE format('ALTER TABLE %I.companies ADD COLUMN IF NOT EXISTS domain text', tenant_schema);
    EXECUTE format('ALTER TABLE %I.companies ADD COLUMN IF NOT EXISTS last_activity_at timestamptz', tenant_schema);
    EXECUTE format('ALTER TABLE %I.companies ADD COLUMN IF NOT EXISTS hubspot_id text', tenant_schema);
    EXECUTE format('ALTER TABLE %I.companies ADD COLUMN IF NOT EXISTS procore_id text', tenant_schema);

    EXECUTE format('ALTER TABLE %I.contacts ADD COLUMN IF NOT EXISTS role %I.contact_role', tenant_schema, tenant_schema);
    EXECUTE format('ALTER TABLE %I.contacts ADD COLUMN IF NOT EXISTS linkedin_url text', tenant_schema);

    EXECUTE format('ALTER TABLE %I.properties ADD COLUMN IF NOT EXISTS type %I.property_type', tenant_schema, tenant_schema);
    EXECUTE format('ALTER TABLE %I.properties ADD COLUMN IF NOT EXISTS floors integer', tenant_schema);
    EXECUTE format('ALTER TABLE %I.properties ADD COLUMN IF NOT EXISTS roof_area integer', tenant_schema);
    EXECUTE format('ALTER TABLE %I.properties ADD COLUMN IF NOT EXISTS last_activity_at timestamptz', tenant_schema);
    EXECUTE format('ALTER TABLE %I.properties ADD COLUMN IF NOT EXISTS procore_id text', tenant_schema);
    EXECUTE format('ALTER TABLE %I.properties ADD COLUMN IF NOT EXISTS companycam_id text', tenant_schema);

    EXECUTE format('CREATE INDEX IF NOT EXISTS companies_industry_idx ON %I.companies (industry)', tenant_schema);
    EXECUTE format('CREATE INDEX IF NOT EXISTS companies_last_activity_idx ON %I.companies (last_activity_at)', tenant_schema);
    EXECUTE format('CREATE INDEX IF NOT EXISTS contacts_role_idx ON %I.contacts (role)', tenant_schema);
    EXECUTE format('CREATE INDEX IF NOT EXISTS properties_type_idx ON %I.properties (type)', tenant_schema);
    EXECUTE format('CREATE INDEX IF NOT EXISTS properties_last_activity_idx ON %I.properties (last_activity_at)', tenant_schema);

    EXECUTE format(
      'UPDATE %I.companies c
          SET last_activity_at = a.last_activity_at
         FROM (
           SELECT company_id, max(occurred_at) AS last_activity_at
             FROM %I.activities
            WHERE company_id IS NOT NULL
            GROUP BY company_id
         ) a
        WHERE c.id = a.company_id',
      tenant_schema,
      tenant_schema
    );

    EXECUTE format(
      'UPDATE %I.properties p
          SET last_activity_at = a.last_activity_at
         FROM (
           SELECT property_id, max(occurred_at) AS last_activity_at
             FROM %I.activities
            WHERE property_id IS NOT NULL
            GROUP BY property_id
         ) a
        WHERE p.id = a.property_id',
      tenant_schema,
      tenant_schema
    );

    EXECUTE format(
      'CREATE OR REPLACE FUNCTION %I.refresh_redesign_last_activity()
       RETURNS trigger
       LANGUAGE plpgsql
       AS $fn$
       DECLARE
         company_ids uuid[];
         property_ids uuid[];
       BEGIN
         IF TG_OP = ''INSERT'' THEN
           company_ids := ARRAY(SELECT DISTINCT id FROM unnest(ARRAY[NEW.company_id]) AS id WHERE id IS NOT NULL);
           property_ids := ARRAY(SELECT DISTINCT id FROM unnest(ARRAY[NEW.property_id]) AS id WHERE id IS NOT NULL);
         ELSIF TG_OP = ''UPDATE'' THEN
           company_ids := ARRAY(SELECT DISTINCT id FROM unnest(ARRAY[OLD.company_id, NEW.company_id]) AS id WHERE id IS NOT NULL);
           property_ids := ARRAY(SELECT DISTINCT id FROM unnest(ARRAY[OLD.property_id, NEW.property_id]) AS id WHERE id IS NOT NULL);
         ELSE
           company_ids := ARRAY(SELECT DISTINCT id FROM unnest(ARRAY[OLD.company_id]) AS id WHERE id IS NOT NULL);
           property_ids := ARRAY(SELECT DISTINCT id FROM unnest(ARRAY[OLD.property_id]) AS id WHERE id IS NOT NULL);
         END IF;

         IF array_length(company_ids, 1) IS NOT NULL THEN
           UPDATE companies c
              SET last_activity_at = (
                SELECT max(a.occurred_at)
                  FROM activities a
                 WHERE a.company_id = c.id
              )
            WHERE c.id = ANY(company_ids);
         END IF;

         IF array_length(property_ids, 1) IS NOT NULL THEN
           UPDATE properties p
              SET last_activity_at = (
                SELECT max(a.occurred_at)
                  FROM activities a
                 WHERE a.property_id = p.id
              )
            WHERE p.id = ANY(property_ids);
         END IF;

         RETURN COALESCE(NEW, OLD);
       END
       $fn$',
      tenant_schema
    );

    EXECUTE format('DROP TRIGGER IF EXISTS redesign_last_activity_refresh ON %I.activities', tenant_schema);
    EXECUTE format(
      'CREATE TRIGGER redesign_last_activity_refresh
       AFTER INSERT OR UPDATE OF company_id, property_id, occurred_at OR DELETE ON %I.activities
       FOR EACH ROW
       EXECUTE FUNCTION %I.refresh_redesign_last_activity()',
      tenant_schema,
      tenant_schema
    );
  END LOOP;
END $$;

-- TENANT_SCHEMA_START
DO $tenant$
BEGIN
  IF to_regclass('companies') IS NULL THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_type
     WHERE typname = 'company_industry'
       AND typnamespace = current_schema()::regnamespace
  ) THEN
    CREATE TYPE company_industry AS ENUM (
      'school_district',
      'healthcare',
      'industrial',
      'office_mixed',
      'retail',
      'government',
      'hospitality'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_type
     WHERE typname = 'contact_role'
       AND typnamespace = current_schema()::regnamespace
  ) THEN
    CREATE TYPE contact_role AS ENUM (
      'decision_maker',
      'influencer',
      'gatekeeper',
      'procurement',
      'engineer',
      'owner'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_type
     WHERE typname = 'property_type'
       AND typnamespace = current_schema()::regnamespace
  ) THEN
    CREATE TYPE property_type AS ENUM (
      'office',
      'industrial',
      'retail',
      'school',
      'healthcare',
      'government',
      'mixed_use'
    );
  END IF;

  ALTER TABLE companies ADD COLUMN IF NOT EXISTS industry company_industry;
  ALTER TABLE companies ADD COLUMN IF NOT EXISTS region text;
  ALTER TABLE companies ADD COLUMN IF NOT EXISTS domain text;
  ALTER TABLE companies ADD COLUMN IF NOT EXISTS last_activity_at timestamptz;
  ALTER TABLE companies ADD COLUMN IF NOT EXISTS hubspot_id text;
  ALTER TABLE companies ADD COLUMN IF NOT EXISTS procore_id text;

  ALTER TABLE contacts ADD COLUMN IF NOT EXISTS role contact_role;
  ALTER TABLE contacts ADD COLUMN IF NOT EXISTS linkedin_url text;

  ALTER TABLE properties ADD COLUMN IF NOT EXISTS type property_type;
  ALTER TABLE properties ADD COLUMN IF NOT EXISTS floors integer;
  ALTER TABLE properties ADD COLUMN IF NOT EXISTS roof_area integer;
  ALTER TABLE properties ADD COLUMN IF NOT EXISTS last_activity_at timestamptz;
  ALTER TABLE properties ADD COLUMN IF NOT EXISTS procore_id text;
  ALTER TABLE properties ADD COLUMN IF NOT EXISTS companycam_id text;

  CREATE INDEX IF NOT EXISTS companies_industry_idx ON companies (industry);
  CREATE INDEX IF NOT EXISTS companies_last_activity_idx ON companies (last_activity_at);
  CREATE INDEX IF NOT EXISTS contacts_role_idx ON contacts (role);
  CREATE INDEX IF NOT EXISTS properties_type_idx ON properties (type);
  CREATE INDEX IF NOT EXISTS properties_last_activity_idx ON properties (last_activity_at);

  UPDATE companies c
     SET last_activity_at = a.last_activity_at
    FROM (
      SELECT company_id, max(occurred_at) AS last_activity_at
        FROM activities
       WHERE company_id IS NOT NULL
       GROUP BY company_id
    ) a
   WHERE c.id = a.company_id;

  UPDATE properties p
     SET last_activity_at = a.last_activity_at
    FROM (
      SELECT property_id, max(occurred_at) AS last_activity_at
        FROM activities
       WHERE property_id IS NOT NULL
       GROUP BY property_id
    ) a
   WHERE p.id = a.property_id;

  CREATE OR REPLACE FUNCTION refresh_redesign_last_activity()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $fn$
  DECLARE
    company_ids uuid[];
    property_ids uuid[];
  BEGIN
    IF TG_OP = 'INSERT' THEN
      company_ids := ARRAY(SELECT DISTINCT id FROM unnest(ARRAY[NEW.company_id]) AS id WHERE id IS NOT NULL);
      property_ids := ARRAY(SELECT DISTINCT id FROM unnest(ARRAY[NEW.property_id]) AS id WHERE id IS NOT NULL);
    ELSIF TG_OP = 'UPDATE' THEN
      company_ids := ARRAY(SELECT DISTINCT id FROM unnest(ARRAY[OLD.company_id, NEW.company_id]) AS id WHERE id IS NOT NULL);
      property_ids := ARRAY(SELECT DISTINCT id FROM unnest(ARRAY[OLD.property_id, NEW.property_id]) AS id WHERE id IS NOT NULL);
    ELSE
      company_ids := ARRAY(SELECT DISTINCT id FROM unnest(ARRAY[OLD.company_id]) AS id WHERE id IS NOT NULL);
      property_ids := ARRAY(SELECT DISTINCT id FROM unnest(ARRAY[OLD.property_id]) AS id WHERE id IS NOT NULL);
    END IF;

    IF array_length(company_ids, 1) IS NOT NULL THEN
      UPDATE companies c
         SET last_activity_at = (
           SELECT max(a.occurred_at)
             FROM activities a
            WHERE a.company_id = c.id
         )
       WHERE c.id = ANY(company_ids);
    END IF;

    IF array_length(property_ids, 1) IS NOT NULL THEN
      UPDATE properties p
         SET last_activity_at = (
           SELECT max(a.occurred_at)
             FROM activities a
            WHERE a.property_id = p.id
         )
       WHERE p.id = ANY(property_ids);
    END IF;

    RETURN COALESCE(NEW, OLD);
  END
  $fn$;

  DROP TRIGGER IF EXISTS redesign_last_activity_refresh ON activities;
  CREATE TRIGGER redesign_last_activity_refresh
    AFTER INSERT OR UPDATE OF company_id, property_id, occurred_at OR DELETE ON activities
    FOR EACH ROW
    EXECUTE FUNCTION refresh_redesign_last_activity();
END
$tenant$;
-- TENANT_SCHEMA_END
