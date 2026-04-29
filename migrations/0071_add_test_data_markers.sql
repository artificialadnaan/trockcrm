-- Migration 0071: Add explicit test-data markers for synthetic CRM records.
-- These flags let seeded demo/test records appear in user dashboards while being
-- easy to filter from reports and permanently clean up later.

DO $$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname LIKE 'office\_%' ESCAPE '\'
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = schema_name AND table_name = 'companies') THEN
      EXECUTE format('ALTER TABLE %I.companies ADD COLUMN IF NOT EXISTS is_test_data boolean NOT NULL DEFAULT false', schema_name);
      EXECUTE format('CREATE INDEX IF NOT EXISTS companies_is_test_data_idx ON %I.companies (is_test_data) WHERE is_test_data = true', schema_name);
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = schema_name AND table_name = 'contacts') THEN
      EXECUTE format('ALTER TABLE %I.contacts ADD COLUMN IF NOT EXISTS is_test_data boolean NOT NULL DEFAULT false', schema_name);
      EXECUTE format('CREATE INDEX IF NOT EXISTS contacts_is_test_data_idx ON %I.contacts (is_test_data) WHERE is_test_data = true', schema_name);
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = schema_name AND table_name = 'properties') THEN
      EXECUTE format('ALTER TABLE %I.properties ADD COLUMN IF NOT EXISTS is_test_data boolean NOT NULL DEFAULT false', schema_name);
      EXECUTE format('CREATE INDEX IF NOT EXISTS properties_is_test_data_idx ON %I.properties (is_test_data) WHERE is_test_data = true', schema_name);
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = schema_name AND table_name = 'leads') THEN
      EXECUTE format('ALTER TABLE %I.leads ADD COLUMN IF NOT EXISTS is_test_data boolean NOT NULL DEFAULT false', schema_name);
      EXECUTE format('CREATE INDEX IF NOT EXISTS leads_is_test_data_idx ON %I.leads (is_test_data) WHERE is_test_data = true', schema_name);
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = schema_name AND table_name = 'deals') THEN
      EXECUTE format('ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS is_test_data boolean NOT NULL DEFAULT false', schema_name);
      EXECUTE format('CREATE INDEX IF NOT EXISTS deals_is_test_data_idx ON %I.deals (is_test_data) WHERE is_test_data = true', schema_name);
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = schema_name AND table_name = 'tasks') THEN
      EXECUTE format('ALTER TABLE %I.tasks ADD COLUMN IF NOT EXISTS is_test_data boolean NOT NULL DEFAULT false', schema_name);
      EXECUTE format('CREATE INDEX IF NOT EXISTS tasks_is_test_data_idx ON %I.tasks (is_test_data) WHERE is_test_data = true', schema_name);
    END IF;
  END LOOP;
END $$;
