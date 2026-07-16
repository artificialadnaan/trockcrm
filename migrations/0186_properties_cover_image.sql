-- Migration 0186: optional cover photo for the property profile.
--
-- Adds two nullable keys to every tenant `properties` table:
--   image_r2_key            -- full-size original object in R2
--   image_thumbnail_r2_key  -- small sharp-generated JPEG used for the header avatar
--
-- Both null until a photo is uploaded. The application serves these to clients as presigned URLs,
-- never as raw keys. Idempotent (ADD COLUMN IF NOT EXISTS) so it is safe to re-run across offices.

DO $tenant$
DECLARE schema_name text;
BEGIN
  FOR schema_name IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^office_' ORDER BY nspname LOOP
    IF to_regclass(format('%I.properties', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE %I.properties
         ADD COLUMN IF NOT EXISTS image_r2_key text,
         ADD COLUMN IF NOT EXISTS image_thumbnail_r2_key text',
      schema_name
    );
  END LOOP;
END
$tenant$;

-- New tenants: the office provisioner replays this block (office_dallas -> new schema) when an office is
-- created after this deploy, so a fresh `properties` table gets these columns too. Without it, property
-- detail + image routes in a new office would fail on the missing columns.
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.properties
  ADD COLUMN IF NOT EXISTS image_r2_key text,
  ADD COLUMN IF NOT EXISTS image_thumbnail_r2_key text;
-- TENANT_SCHEMA_END
