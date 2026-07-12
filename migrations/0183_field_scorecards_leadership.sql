-- Migration 0183: Leadership Scorecard is a distinct scorecard KIND stored in the same
-- field_scorecards tables, discriminated by `kind` ('project' default | 'leadership').
-- Also re-adds the `summary` free-text column (voice-dictatable Project Summary) used by
-- leadership cards. Idempotent across all tenant office_* schemas. Project records are
-- unaffected (kind defaults to 'project').

DO $tenant$
DECLARE schema_name text;
BEGIN
  FOR schema_name IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^office_' ORDER BY nspname LOOP
    IF to_regclass(format('%I.field_scorecards', schema_name)) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('ALTER TABLE %I.field_scorecards ADD COLUMN IF NOT EXISTS kind varchar(20) NOT NULL DEFAULT ''project''', schema_name);
    EXECUTE format('ALTER TABLE %I.field_scorecards ADD COLUMN IF NOT EXISTS summary text', schema_name);
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema).
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.field_scorecards ADD COLUMN IF NOT EXISTS kind varchar(20) NOT NULL DEFAULT 'project';
ALTER TABLE office_dallas.field_scorecards ADD COLUMN IF NOT EXISTS summary text;
-- TENANT_SCHEMA_END
