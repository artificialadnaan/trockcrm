-- Migration 0019: Property and lead schema foundation
-- Adds first-class properties and leads, captures lead stage lineage,
-- and backfills nullable deal lineage columns for later conversion rollout.

DO $$ BEGIN
  CREATE TYPE lead_status AS ENUM ('open', 'converted', 'disqualified');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname LIKE 'office\_%' ESCAPE '\'
  LOOP
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
      'CREATE INDEX IF NOT EXISTS properties_company_id_idx
         ON %I.properties (company_id)',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS properties_company_name_idx
         ON %I.properties (company_id, name)',
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
      'CREATE INDEX IF NOT EXISTS leads_company_id_idx
         ON %I.leads (company_id)',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS leads_property_id_idx
         ON %I.leads (property_id)',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS leads_assigned_rep_id_idx
         ON %I.leads (assigned_rep_id)',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS leads_stage_id_idx
         ON %I.leads (stage_id)',
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
      'CREATE INDEX IF NOT EXISTS deals_property_id_idx
         ON %I.deals (property_id)',
      schema_name
    );

    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS deals_source_lead_id_idx
         ON %I.deals (source_lead_id)
         WHERE source_lead_id IS NOT NULL',
      schema_name
    );
  END LOOP;
END $$;
