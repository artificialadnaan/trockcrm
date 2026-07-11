-- 0182_field_scorecards_summary.sql
-- V2 Field Scorecard "Summary / Action Items": a single nullable free-text summary (voice-dictated
-- on mobile) that replaces the discrete action_items list for new submissions. action_items stays
-- for historical (V1) rows (read-only back-compat) and is intentionally left unchanged here.
-- Per-tenant (office_*) + the TENANT_SCHEMA block for new tenants. Idempotent / replayable.

-- Existing tenants.
DO $tenant$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\_%' ESCAPE '\' ORDER BY nspname
  LOOP
    IF to_regclass(format('%I.field_scorecards', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      $sql$
        ALTER TABLE %1$I.field_scorecards
          ADD COLUMN IF NOT EXISTS summary text;
      $sql$,
      schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema).
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.field_scorecards
  ADD COLUMN IF NOT EXISTS summary text;
-- TENANT_SCHEMA_END
