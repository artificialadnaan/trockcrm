-- Migration 0017: Estimating sub-stages
-- Adds estimating_substage enum and column to deals table for tracking
-- internal estimating workflow progression.

DO $$ BEGIN
  CREATE TYPE estimating_substage AS ENUM (
    'scope_review', 'site_visit', 'missing_info',
    'building_estimate', 'under_review', 'sent_to_client'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname LIKE 'office\_%' ESCAPE '\'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.deals
         ADD COLUMN IF NOT EXISTS estimating_substage estimating_substage',
      schema_name
    );
  END LOOP;
END $$;
