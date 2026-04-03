-- Migration 0007: CompanyCam integration
-- Adds CompanyCam project linking to deals and external photo URL support to files.
-- Runs against all tenant schemas (office_*).

DO $$
DECLARE
  tenant_schema TEXT;
BEGIN
  FOR tenant_schema IN
    SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'office_%'
  LOOP
    -- Add companycam_project_id to deals for project linking
    EXECUTE format('ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS companycam_project_id VARCHAR(50)', tenant_schema);
    EXECUTE format('CREATE INDEX IF NOT EXISTS deals_companycam_project_idx ON %I.deals(companycam_project_id)', tenant_schema);

    -- Add external URL support to files (for CompanyCam CDN photos)
    EXECUTE format('ALTER TABLE %I.files ADD COLUMN IF NOT EXISTS external_url VARCHAR(2000)', tenant_schema);
    EXECUTE format('ALTER TABLE %I.files ADD COLUMN IF NOT EXISTS external_thumbnail_url VARCHAR(2000)', tenant_schema);
    EXECUTE format('ALTER TABLE %I.files ADD COLUMN IF NOT EXISTS companycam_photo_id VARCHAR(50)', tenant_schema);
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS files_companycam_photo_idx ON %I.files(companycam_photo_id) WHERE companycam_photo_id IS NOT NULL', tenant_schema);

    RAISE NOTICE 'Applied CompanyCam migration to schema: %', tenant_schema;
  END LOOP;
END $$;
