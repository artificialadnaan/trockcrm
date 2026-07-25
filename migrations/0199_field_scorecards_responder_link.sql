-- Migration 0199: add the picked field-responder LINK to field_scorecards. When a field user selects the
-- superintendent / PM from the field_responders roster (T-Rock Cam scorecard picker) we store WHICH roster
-- person they picked (nullable FK) — separate from the free-text superintendent_name / pm_name, which stay as
-- the display label. Corrective-action + completed-scorecard recipient resolution PREFERS this picked responder
-- (resolved to the roster email at send time), falling back to the deal's Team-tab super/PM when null (a typed
-- name or no pick). Resolving at send time — instead of writing a deal_team_members row from the scorecard
-- transaction — is what keeps the scorecard path free of the assignment locks / notification-cycle restarts.
-- ON DELETE SET NULL so removing a roster person clears the link but leaves the scorecard intact.
--
-- Idempotent across all tenant office_* schemas (matches 0198's pattern). No CREATE INDEX CONCURRENTLY: these
-- are plain ADD COLUMN IF NOT EXISTS on an existing table.

DO $tenant$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\_%' ESCAPE '\' ORDER BY nspname
  LOOP
    -- Both tables must exist in this office schema (field_responders from 0198, field_scorecards from the
    -- original scorecard migration). Skip a schema missing either — the provisioner replays the block below.
    IF to_regclass(format('%I.field_scorecards', schema_name)) IS NULL
       OR to_regclass(format('%I.field_responders', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE %I.field_scorecards
         ADD COLUMN IF NOT EXISTS superintendent_responder_id uuid
         REFERENCES %I.field_responders(id) ON DELETE SET NULL',
      schema_name, schema_name
    );
    EXECUTE format(
      'ALTER TABLE %I.field_scorecards
         ADD COLUMN IF NOT EXISTS pm_responder_id uuid
         REFERENCES %I.field_responders(id) ON DELETE SET NULL',
      schema_name, schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema).
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.field_scorecards
  ADD COLUMN IF NOT EXISTS superintendent_responder_id uuid
  REFERENCES office_dallas.field_responders(id) ON DELETE SET NULL;
ALTER TABLE office_dallas.field_scorecards
  ADD COLUMN IF NOT EXISTS pm_responder_id uuid
  REFERENCES office_dallas.field_responders(id) ON DELETE SET NULL;
-- TENANT_SCHEMA_END
