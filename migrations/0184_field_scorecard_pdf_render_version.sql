-- Migration 0184: Version stored Field Scorecard PDF artifacts so an older immutable R2 object can be
-- regenerated when the renderer gains material content (version 2 adds embedded evidence photos).
-- Existing artifacts are version 1 by definition; newly rendered artifacts stamp the current version.
-- Idempotent across all tenant office_* schemas.

DO $tenant$
DECLARE schema_name text;
BEGIN
  FOR schema_name IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^office_' ORDER BY nspname LOOP
    IF to_regclass(format('%I.field_scorecards', schema_name)) IS NULL THEN CONTINUE; END IF;
    EXECUTE format(
      'ALTER TABLE %I.field_scorecards ADD COLUMN IF NOT EXISTS pdf_render_version smallint NOT NULL DEFAULT 1',
      schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema).
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.field_scorecards
  ADD COLUMN IF NOT EXISTS pdf_render_version smallint NOT NULL DEFAULT 1;
-- TENANT_SCHEMA_END
