-- 0169_files_thumbnail_r2_key.sql
-- Add a nullable `thumbnail_r2_key` to each tenant's `files` table.
--
-- Holds the R2 key of a small server-generated JPEG thumbnail for an image file.
-- The photo grid loads this (quick load); the lightbox keeps using the full-size
-- original at `r2_key`. Null for non-image files and for every row that predates
-- this column — display code falls back to the original key when it's null, so the
-- backfill of historical thumbnails is optional and can happen later.
--
-- Per-tenant (office_*) + the TENANT_SCHEMA block for new tenants. Idempotent / replayable.

-- Existing tenants.
DO $tenant$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\_%' ESCAPE '\' ORDER BY nspname
  LOOP
    IF to_regclass(format('%I.files', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE %I.files ADD COLUMN IF NOT EXISTS thumbnail_r2_key varchar(1000)',
      schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema). Runs idempotently for
-- office_dallas at migration time too (redundant with the DO-loop above, guarded by IF NOT EXISTS).
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.files ADD COLUMN IF NOT EXISTS thumbnail_r2_key varchar(1000);
-- TENANT_SCHEMA_END
