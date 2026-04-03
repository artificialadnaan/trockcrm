-- Migration 0008: Photo capture system
-- Adds GPS columns to deals and photo feed index across all tenant schemas.

DO $$
DECLARE
  tenant_schema TEXT;
BEGIN
  FOR tenant_schema IN
    SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'office_%'
  LOOP
    -- GPS coordinates for deal property address
    EXECUTE format('ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS property_lat NUMERIC(10,7)', tenant_schema);
    EXECUTE format('ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS property_lng NUMERIC(10,7)', tenant_schema);

    -- Index for photo feed queries (cross-deal, sorted by date)
    EXECUTE format('CREATE INDEX IF NOT EXISTS files_photo_feed_idx ON %I.files (uploaded_by, category, COALESCE(taken_at, created_at) DESC) WHERE category = ''photo'' AND is_active = TRUE', tenant_schema);

    RAISE NOTICE 'Applied photo capture migration to schema: %', tenant_schema;
  END LOOP;
END $$;
