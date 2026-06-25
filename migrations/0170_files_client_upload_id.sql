-- 0170_files_client_upload_id.sql
-- Add a nullable `client_upload_id` to each tenant's `files` table + a partial unique index.
--
-- This is the idempotency key for the resilient field-photo upload queue. The mobile app generates a
-- stable id per captured photo and sends it on confirm-upload. If a resumed/background queue re-runs an
-- upload that already succeeded (e.g. the app was killed after the server created the row but before the
-- queue marked it done), the server returns the existing row instead of creating a DUPLICATE photo.
--
-- Null for every row that predates this column and for any non-field upload path that doesn't send a
-- client id. The unique index is PARTIAL (WHERE NOT NULL) so historical nulls don't collide and the
-- index only covers rows that actually carry an idempotency key.
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
      'ALTER TABLE %I.files ADD COLUMN IF NOT EXISTS client_upload_id varchar(64)',
      schema_name
    );
    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS files_client_upload_id_key ON %I.files (client_upload_id) WHERE client_upload_id IS NOT NULL',
      schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema). Runs idempotently for
-- office_dallas at migration time too (redundant with the DO-loop above, guarded by IF NOT EXISTS).
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.files ADD COLUMN IF NOT EXISTS client_upload_id varchar(64);
CREATE UNIQUE INDEX IF NOT EXISTS files_client_upload_id_key ON office_dallas.files (client_upload_id) WHERE client_upload_id IS NOT NULL;
-- TENANT_SCHEMA_END
