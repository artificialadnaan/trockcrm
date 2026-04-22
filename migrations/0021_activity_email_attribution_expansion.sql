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
  ) AND EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name = 'companies'
  ) AND EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name = 'properties'
  ) AND EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name = 'leads'
  ) AND EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name = 'deals'
  ) AND EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name = 'contacts'
  ) AND EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name = 'emails'
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
      deal_id = COALESCE(
        deal_id,
        (SELECT e.deal_id FROM emails e WHERE e.id = activities.email_id)
      ),
      contact_id = COALESCE(
        contact_id,
        (SELECT e.contact_id FROM emails e WHERE e.id = activities.email_id)
      ),
      company_id = COALESCE(
        company_id,
        (SELECT d.company_id FROM deals d WHERE d.id = activities.deal_id),
        (SELECT c.company_id FROM contacts c WHERE c.id = activities.contact_id),
        (SELECT d.company_id
           FROM emails e
           JOIN deals d ON d.id = e.deal_id
          WHERE e.id = activities.email_id),
        (SELECT c.company_id
           FROM emails e
           JOIN contacts c ON c.id = e.contact_id
          WHERE e.id = activities.email_id)
      ),
      property_id = COALESCE(
        property_id,
        (SELECT d.property_id FROM deals d WHERE d.id = activities.deal_id),
        (SELECT d.property_id
           FROM emails e
           JOIN deals d ON d.id = e.deal_id
          WHERE e.id = activities.email_id)
      ),
      lead_id = COALESCE(
        lead_id,
        (SELECT d.source_lead_id FROM deals d WHERE d.id = activities.deal_id),
        (SELECT d.source_lead_id
           FROM emails e
           JOIN deals d ON d.id = e.deal_id
          WHERE e.id = activities.email_id)
      ),
      source_entity_type = CASE
        WHEN COALESCE(
          deal_id,
          (SELECT e.deal_id FROM emails e WHERE e.id = activities.email_id)
        ) IS NOT NULL THEN 'deal'::activity_source_entity
        WHEN COALESCE(
          contact_id,
          (SELECT e.contact_id FROM emails e WHERE e.id = activities.email_id)
        ) IS NOT NULL THEN 'contact'::activity_source_entity
        WHEN COALESCE(
          company_id,
          (SELECT d.company_id FROM deals d WHERE d.id = activities.deal_id),
          (SELECT c.company_id FROM contacts c WHERE c.id = activities.contact_id),
          (SELECT d.company_id
             FROM emails e
             JOIN deals d ON d.id = e.deal_id
            WHERE e.id = activities.email_id),
          (SELECT c.company_id
             FROM emails e
             JOIN contacts c ON c.id = e.contact_id
            WHERE e.id = activities.email_id)
        ) IS NOT NULL THEN 'company'::activity_source_entity
        ELSE source_entity_type
      END,
      source_entity_id = COALESCE(
        source_entity_id,
        deal_id,
        (SELECT e.deal_id FROM emails e WHERE e.id = activities.email_id),
        contact_id,
        (SELECT e.contact_id FROM emails e WHERE e.id = activities.email_id),
        company_id,
        (SELECT d.company_id FROM deals d WHERE d.id = activities.deal_id),
        (SELECT c.company_id FROM contacts c WHERE c.id = activities.contact_id),
        (SELECT d.company_id
           FROM emails e
           JOIN deals d ON d.id = e.deal_id
          WHERE e.id = activities.email_id),
        (SELECT c.company_id
           FROM emails e
           JOIN contacts c ON c.id = e.contact_id
          WHERE e.id = activities.email_id)
      )
    WHERE source_entity_type IS NULL
       OR source_entity_id IS NULL
       OR deal_id IS NULL
       OR contact_id IS NULL
       OR company_id IS NULL
       OR property_id IS NULL
       OR lead_id IS NULL;

    UPDATE activities
    SET
      source_entity_type = COALESCE(source_entity_type, 'company'::activity_source_entity),
      source_entity_id = COALESCE(source_entity_id, company_id, contact_id, deal_id, id)
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
      AND EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = schema_name
          AND table_name = 'activities'
      )
      AND EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = schema_name
          AND table_name = 'companies'
      )
      AND EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = schema_name
          AND table_name = 'properties'
      )
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
          AND table_name = 'deals'
      )
      AND EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = schema_name
          AND table_name = 'contacts'
      )
      AND EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = schema_name
          AND table_name = 'emails'
      )
  LOOP
    PERFORM set_config('search_path', format('%I,public', tenant_schema), true);
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
  ) AND EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name = 'companies'
  ) AND EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name = 'properties'
  ) AND EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name = 'leads'
  ) AND EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name = 'deals'
  ) AND EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name = 'contacts'
  ) AND EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name = 'emails'
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
      deal_id = COALESCE(
        deal_id,
        (SELECT e.deal_id FROM emails e WHERE e.id = activities.email_id)
      ),
      contact_id = COALESCE(
        contact_id,
        (SELECT e.contact_id FROM emails e WHERE e.id = activities.email_id)
      ),
      company_id = COALESCE(
        company_id,
        (SELECT d.company_id FROM deals d WHERE d.id = activities.deal_id),
        (SELECT c.company_id FROM contacts c WHERE c.id = activities.contact_id),
        (SELECT d.company_id
           FROM emails e
           JOIN deals d ON d.id = e.deal_id
          WHERE e.id = activities.email_id),
        (SELECT c.company_id
           FROM emails e
           JOIN contacts c ON c.id = e.contact_id
          WHERE e.id = activities.email_id)
      ),
      property_id = COALESCE(
        property_id,
        (SELECT d.property_id FROM deals d WHERE d.id = activities.deal_id),
        (SELECT d.property_id
           FROM emails e
           JOIN deals d ON d.id = e.deal_id
          WHERE e.id = activities.email_id)
      ),
      lead_id = COALESCE(
        lead_id,
        (SELECT d.source_lead_id FROM deals d WHERE d.id = activities.deal_id),
        (SELECT d.source_lead_id
           FROM emails e
           JOIN deals d ON d.id = e.deal_id
          WHERE e.id = activities.email_id)
      ),
      source_entity_type = CASE
        WHEN COALESCE(
          deal_id,
          (SELECT e.deal_id FROM emails e WHERE e.id = activities.email_id)
        ) IS NOT NULL THEN 'deal'::activity_source_entity
        WHEN COALESCE(
          contact_id,
          (SELECT e.contact_id FROM emails e WHERE e.id = activities.email_id)
        ) IS NOT NULL THEN 'contact'::activity_source_entity
        WHEN COALESCE(
          company_id,
          (SELECT d.company_id FROM deals d WHERE d.id = activities.deal_id),
          (SELECT c.company_id FROM contacts c WHERE c.id = activities.contact_id),
          (SELECT d.company_id
             FROM emails e
             JOIN deals d ON d.id = e.deal_id
            WHERE e.id = activities.email_id),
          (SELECT c.company_id
             FROM emails e
             JOIN contacts c ON c.id = e.contact_id
            WHERE e.id = activities.email_id)
        ) IS NOT NULL THEN 'company'::activity_source_entity
        ELSE source_entity_type
      END,
      source_entity_id = COALESCE(
        source_entity_id,
        deal_id,
        (SELECT e.deal_id FROM emails e WHERE e.id = activities.email_id),
        contact_id,
        (SELECT e.contact_id FROM emails e WHERE e.id = activities.email_id),
        company_id,
        (SELECT d.company_id FROM deals d WHERE d.id = activities.deal_id),
        (SELECT c.company_id FROM contacts c WHERE c.id = activities.contact_id),
        (SELECT d.company_id
           FROM emails e
           JOIN deals d ON d.id = e.deal_id
          WHERE e.id = activities.email_id),
        (SELECT c.company_id
           FROM emails e
           JOIN contacts c ON c.id = e.contact_id
          WHERE e.id = activities.email_id)
      )
    WHERE source_entity_type IS NULL
       OR source_entity_id IS NULL
       OR deal_id IS NULL
       OR contact_id IS NULL
       OR company_id IS NULL
       OR property_id IS NULL
       OR lead_id IS NULL;

    UPDATE activities
    SET
      source_entity_type = COALESCE(source_entity_type, 'company'::activity_source_entity),
      source_entity_id = COALESCE(source_entity_id, company_id, contact_id, deal_id, id)
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
