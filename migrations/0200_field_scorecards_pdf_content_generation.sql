-- Migration 0200: field_scorecards.pdf_content_generation — the scorecard `updated_at` the stored PDF
-- artifact was rendered from, so staleness detection can notice content changes.
--
-- Bug this closes: needsScorecardPdfRegeneration decided on pdf_r2_key + pdf_render_version ALONE. Once a
-- valid content-addressed artifact existed it was considered current forever, so a corrective action
-- documented AFTER submit was never reflected in the downloaded PDF — the download presigned the
-- submit-time object. Scorecard EDITS avoided this only because the edit routes fire a best-effort
-- background re-render; when that fire-and-forget render fails there is no path to repair.
--
-- Written in the same guarded CAS UPDATE that already publishes pdf_r2_key / pdf_render_version, set to
-- the updated_at the render read. The download path regenerates when it differs from the live updated_at.
--
-- Nullable: every pre-migration row reads NULL and is therefore treated as stale, which is consistent with
-- the concurrent v2 -> v3 render-version bump already marking those rows stale. Per-tenant (office_*
-- schemas), idempotent + guarded per schema.

DO $tenant$
DECLARE schema_name text;
BEGIN
  FOR schema_name IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^office_' ORDER BY nspname LOOP
    IF to_regclass(format('%I.field_scorecards', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format(
      'ALTER TABLE %I.field_scorecards ADD COLUMN IF NOT EXISTS pdf_content_generation timestamptz',
      schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema).
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.field_scorecards ADD COLUMN IF NOT EXISTS pdf_content_generation timestamptz;
-- TENANT_SCHEMA_END
