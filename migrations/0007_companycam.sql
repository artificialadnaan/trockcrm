-- Migration 0007: CompanyCam integration
-- Adds CompanyCam project linking to deals and external photo URL support to files.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'deals' AND table_schema = current_schema()) THEN

    -- Add companycam_project_id to deals for project linking
    ALTER TABLE deals ADD COLUMN IF NOT EXISTS companycam_project_id VARCHAR(50);
    CREATE INDEX IF NOT EXISTS deals_companycam_project_idx ON deals(companycam_project_id);

    -- Add external URL support to files (for CompanyCam CDN photos)
    ALTER TABLE files ADD COLUMN IF NOT EXISTS external_url VARCHAR(2000);
    ALTER TABLE files ADD COLUMN IF NOT EXISTS external_thumbnail_url VARCHAR(2000);
    ALTER TABLE files ADD COLUMN IF NOT EXISTS companycam_photo_id VARCHAR(50);
    CREATE UNIQUE INDEX IF NOT EXISTS files_companycam_photo_idx ON files(companycam_photo_id) WHERE companycam_photo_id IS NOT NULL;

    -- Make r2_key nullable for external files (no R2 storage needed)
    -- We use a synthetic key for external files instead
    -- No change needed — we'll use 'external/companycam/{photoId}' as the r2_key

  END IF;
END $$;
