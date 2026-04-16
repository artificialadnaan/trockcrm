-- Migration 0025: Tenant schema baseline reconciliation
-- Repairs legacy office schemas that missed parts of the CRM baseline,
-- including companies/company_id lineage, property/lead scaffolding, and
-- the activity owner rename required by dashboard/report queries.

DO $$ BEGIN
  CREATE TYPE lead_status AS ENUM ('open', 'converted', 'disqualified');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE activity_source_entity AS ENUM ('company', 'property', 'lead', 'deal', 'contact');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name LIKE 'office_%'
  LOOP
    IF EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = schema_name
        AND table_name = 'contacts'
    ) AND EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = schema_name
        AND table_name = 'deals'
    ) THEN
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.companies (
           id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
           name VARCHAR(500) NOT NULL,
           slug VARCHAR(100) UNIQUE NOT NULL,
           category contact_category NOT NULL DEFAULT ''other'',
           address TEXT,
           city VARCHAR(255),
           state VARCHAR(2),
           zip VARCHAR(10),
           phone VARCHAR(20),
           website VARCHAR(500),
           notes TEXT,
           is_active BOOLEAN NOT NULL DEFAULT TRUE,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
         )',
        schema_name
      );

      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS companies_name_idx ON %I.companies(name)',
        schema_name
      );

      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS companies_category_idx ON %I.companies(category)',
        schema_name
      );

      EXECUTE format(
        'ALTER TABLE %I.contacts ADD COLUMN IF NOT EXISTS company_id UUID',
        schema_name
      );

      EXECUTE format(
        'ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS company_id UUID',
        schema_name
      );

      EXECUTE format(
        'ALTER TABLE %I.contacts
           DROP CONSTRAINT IF EXISTS contacts_company_id_companies_id_fk',
        schema_name
      );

      EXECUTE format(
        'ALTER TABLE %I.contacts
           ADD CONSTRAINT contacts_company_id_companies_id_fk
           FOREIGN KEY (company_id) REFERENCES %I.companies(id)',
        schema_name,
        schema_name
      );

      EXECUTE format(
        'ALTER TABLE %I.deals
           DROP CONSTRAINT IF EXISTS deals_company_id_companies_id_fk',
        schema_name
      );

      EXECUTE format(
        'ALTER TABLE %I.deals
           ADD CONSTRAINT deals_company_id_companies_id_fk
           FOREIGN KEY (company_id) REFERENCES %I.companies(id)',
        schema_name,
        schema_name
      );

      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS contacts_company_id_idx ON %I.contacts(company_id)',
        schema_name
      );

      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS deals_company_id_idx ON %I.deals(company_id)',
        schema_name
      );

      BEGIN
        EXECUTE format(
          'CREATE TRIGGER set_companies_updated_at
             BEFORE UPDATE ON %I.companies
             FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
          schema_name
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END;

      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.properties (
           id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
           company_id UUID NOT NULL REFERENCES %I.companies(id),
           name VARCHAR(500) NOT NULL,
           address TEXT,
           city VARCHAR(255),
           state VARCHAR(2),
           zip VARCHAR(10),
           lat NUMERIC(10,7),
           lng NUMERIC(10,7),
           notes TEXT,
           is_active BOOLEAN NOT NULL DEFAULT TRUE,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
         )',
        schema_name,
        schema_name
      );

      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS properties_company_id_idx ON %I.properties(company_id)',
        schema_name
      );

      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS properties_company_name_idx ON %I.properties(company_id, name)',
        schema_name
      );

      BEGIN
        EXECUTE format(
          'CREATE TRIGGER set_properties_updated_at
             BEFORE UPDATE ON %I.properties
             FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
          schema_name
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END;

      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.leads (
           id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
           company_id UUID NOT NULL REFERENCES %I.companies(id),
           property_id UUID NOT NULL REFERENCES %I.properties(id),
           primary_contact_id UUID REFERENCES %I.contacts(id),
           name VARCHAR(500) NOT NULL,
           stage_id UUID NOT NULL,
           assigned_rep_id UUID NOT NULL REFERENCES public.users(id),
           status lead_status NOT NULL DEFAULT ''open'',
           source VARCHAR(100),
           description TEXT,
           last_activity_at TIMESTAMPTZ,
           stage_entered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           converted_at TIMESTAMPTZ,
           is_active BOOLEAN NOT NULL DEFAULT TRUE,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
         )',
        schema_name,
        schema_name,
        schema_name,
        schema_name
      );

      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS leads_company_id_idx ON %I.leads(company_id)',
        schema_name
      );

      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS leads_property_id_idx ON %I.leads(property_id)',
        schema_name
      );

      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS leads_assigned_rep_id_idx ON %I.leads(assigned_rep_id)',
        schema_name
      );

      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS leads_stage_id_idx ON %I.leads(stage_id)',
        schema_name
      );

      BEGIN
        EXECUTE format(
          'CREATE TRIGGER set_leads_updated_at
             BEFORE UPDATE ON %I.leads
             FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
          schema_name
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END;

      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.lead_stage_history (
           id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
           lead_id UUID NOT NULL REFERENCES %I.leads(id),
           from_stage_id UUID,
           to_stage_id UUID NOT NULL,
           changed_by UUID NOT NULL REFERENCES public.users(id),
           is_backward_move BOOLEAN NOT NULL DEFAULT FALSE,
           duration_in_previous_stage INTERVAL,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
         )',
        schema_name,
        schema_name
      );

      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS lead_stage_history_lead_id_idx
           ON %I.lead_stage_history (lead_id, created_at)',
        schema_name
      );

      EXECUTE format(
        'ALTER TABLE %I.deals
         ADD COLUMN IF NOT EXISTS property_id UUID REFERENCES %I.properties(id)',
        schema_name,
        schema_name
      );

      EXECUTE format(
        'ALTER TABLE %I.deals
         ADD COLUMN IF NOT EXISTS source_lead_id UUID REFERENCES %I.leads(id)',
        schema_name,
        schema_name
      );

      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS deals_property_id_idx ON %I.deals(property_id)',
        schema_name
      );

      EXECUTE format(
        'CREATE UNIQUE INDEX IF NOT EXISTS deals_source_lead_id_idx
           ON %I.deals (source_lead_id)
           WHERE source_lead_id IS NOT NULL',
        schema_name
      );
    END IF;

    IF EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = schema_name
        AND table_name = 'activities'
    ) THEN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = schema_name
          AND table_name = 'activities'
          AND column_name = 'user_id'
      ) THEN
        EXECUTE format(
          'ALTER TABLE %I.activities RENAME COLUMN user_id TO responsible_user_id',
          schema_name
        );
      END IF;

      EXECUTE format(
        'ALTER TABLE %I.activities
           ADD COLUMN IF NOT EXISTS performed_by_user_id UUID REFERENCES public.users(id)',
        schema_name
      );

      EXECUTE format(
        'ALTER TABLE %I.activities
           ADD COLUMN IF NOT EXISTS source_entity_type activity_source_entity',
        schema_name
      );

      EXECUTE format(
        'ALTER TABLE %I.activities
           ADD COLUMN IF NOT EXISTS source_entity_id UUID',
        schema_name
      );

      IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = schema_name
          AND table_name = 'companies'
      ) THEN
        EXECUTE format(
          'ALTER TABLE %I.activities
             ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES %I.companies(id)',
          schema_name,
          schema_name
        );
      END IF;

      IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = schema_name
          AND table_name = 'properties'
      ) THEN
        EXECUTE format(
          'ALTER TABLE %I.activities
             ADD COLUMN IF NOT EXISTS property_id UUID REFERENCES %I.properties(id)',
          schema_name,
          schema_name
        );
      END IF;

      IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = schema_name
          AND table_name = 'leads'
      ) THEN
        EXECUTE format(
          'ALTER TABLE %I.activities
             ADD COLUMN IF NOT EXISTS lead_id UUID REFERENCES %I.leads(id)',
          schema_name,
          schema_name
        );
      END IF;

      EXECUTE format(
        'DROP INDEX IF EXISTS %I.activities_user_idx',
        schema_name
      );

      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS activities_responsible_user_idx
           ON %I.activities (responsible_user_id, occurred_at)',
        schema_name
      );

      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS activities_company_idx
           ON %I.activities (company_id, occurred_at)',
        schema_name
      );

      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS activities_property_idx
           ON %I.activities (property_id, occurred_at)',
        schema_name
      );

      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS activities_lead_idx
           ON %I.activities (lead_id, occurred_at)',
        schema_name
      );
    END IF;
  END LOOP;
END $$;
