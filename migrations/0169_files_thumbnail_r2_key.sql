-- 0169_files_thumbnail_r2_key.sql
-- Add a nullable `thumbnail_r2_key` to each tenant's `files` table.
--
-- Holds the R2 key of a small server-generated JPEG thumbnail for an image file.
-- The photo grid loads this (quick load); the lightbox keeps using the full-size
-- original at `r2_key`. Null for non-image files and for every row that predates
-- this column — display code falls back to the original key when it's null, so the
-- backfill of historical thumbnails is optional and can happen later.
--
-- ADD COLUMN IF NOT EXISTS is idempotent: safe to re-run, a no-op where present.
DO $$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname LIKE 'office\_%' ESCAPE '\'
  LOOP
    IF to_regclass(format('%I.files', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I.files ADD COLUMN IF NOT EXISTS thumbnail_r2_key varchar(1000)',
        tenant_schema
      );
    END IF;
  END LOOP;
END $$;
