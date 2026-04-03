-- Migration 0005: Companies table and FK columns
-- Wraps in IF EXISTS check for tenant schemas that may not have these tables yet.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'contacts' AND table_schema = current_schema()) THEN

    -- Create companies table
    CREATE TABLE IF NOT EXISTS companies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(500) NOT NULL,
      slug VARCHAR(100) UNIQUE NOT NULL,
      category contact_category NOT NULL DEFAULT 'other',
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
    );

    CREATE INDEX IF NOT EXISTS companies_name_idx ON companies(name);
    CREATE INDEX IF NOT EXISTS companies_category_idx ON companies(category);

    -- Add company_id to contacts (nullable for backfill)
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
    CREATE INDEX IF NOT EXISTS contacts_company_id_idx ON contacts(company_id);

    -- Add company_id to deals (nullable)
    ALTER TABLE deals ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
    CREATE INDEX IF NOT EXISTS deals_company_id_idx ON deals(company_id);

    -- Updated-at trigger for companies
    BEGIN
      CREATE TRIGGER set_companies_updated_at
        BEFORE UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;

  END IF;
END $$;
