-- 0180_field_scorecards_v2.sql
-- V2 Field Scorecard: eight 1-10 categories, average score, signed acknowledgements, and
-- critical-deficiency-specific evidence. V1 records remain unchanged and render by form_version.

DO $tenant$
DECLARE schema_name text;
BEGIN
  FOR schema_name IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^office_' ORDER BY nspname LOOP
    IF to_regclass(format('%I.field_scorecards', schema_name)) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('ALTER TABLE %I.field_scorecards ADD COLUMN IF NOT EXISTS form_version smallint NOT NULL DEFAULT 1', schema_name);
    EXECUTE format('ALTER TABLE %I.field_scorecards ADD COLUMN IF NOT EXISTS average_score numeric(3,1)', schema_name);
    EXECUTE format('ALTER TABLE %I.field_scorecards ADD COLUMN IF NOT EXISTS superintendent_signature text', schema_name);
    EXECUTE format('ALTER TABLE %I.field_scorecards ADD COLUMN IF NOT EXISTS pm_signature text', schema_name);
    EXECUTE format('ALTER TABLE %I.field_scorecards ADD COLUMN IF NOT EXISTS critical_deficiency_notes jsonb NOT NULL DEFAULT ''{}''::jsonb', schema_name);
    EXECUTE format('ALTER TABLE %I.field_scorecard_photos ADD COLUMN IF NOT EXISTS deficiency_key varchar(40)', schema_name);
  END LOOP;
END $tenant$;

-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.field_scorecards ADD COLUMN IF NOT EXISTS form_version smallint NOT NULL DEFAULT 1;
ALTER TABLE office_dallas.field_scorecards ADD COLUMN IF NOT EXISTS average_score numeric(3,1);
ALTER TABLE office_dallas.field_scorecards ADD COLUMN IF NOT EXISTS superintendent_signature text;
ALTER TABLE office_dallas.field_scorecards ADD COLUMN IF NOT EXISTS pm_signature text;
ALTER TABLE office_dallas.field_scorecards ADD COLUMN IF NOT EXISTS critical_deficiency_notes jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE office_dallas.field_scorecard_photos ADD COLUMN IF NOT EXISTS deficiency_key varchar(40);
-- TENANT_SCHEMA_END
