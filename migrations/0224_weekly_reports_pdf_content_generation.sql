-- Migration 0224: weekly_reports.pdf_content_generation — the CONTENT GENERATION the stored PDF artifact
-- was rendered from, so staleness detection compares like with like.
--
-- Bug this closes. 0222 gave the table `pdf_generated_at` and nothing else, so "is the stored PDF still
-- current?" was answered by comparing the report's content generation against the WALL CLOCK instant the
-- publish transaction began. Before send that generation is widened to cover the rows the render reads
-- live — the weekly_report_projects setup row, the two public.users rows it names, and the selected
-- photos' files rows — and NONE of those touches weekly_reports.updated_at. So:
--
--   1. a render reads the report (one photo, present),
--   2. mid-render — the render downloads and transcodes every photo, up to 90s — the PM soft-deletes that
--      photo from the Files tab, stamping files.deleted_at and moving no timestamp on weekly_reports,
--   3. the publish CAS, conditioned on weekly_reports.updated_at alone, still matches, and
--      pdf_generated_at = now() lands AFTER the delete,
--   4. every later read sees deleted_at <= pdf_generated_at and calls the artifact CURRENT.
--
-- The cached PDF then shows a photograph the web page — which reads live — no longer shows, and nothing
-- ever repairs it: `approved` is where a shared report sits, and no send flow moves updated_at again.
-- The same defect makes publication last-writer-wins, because two renders of different content agree on
-- the one value the CAS compares.
--
-- Recording the generation the bytes were RENDERED FROM fixes both. A change that lands during a render
-- leaves the recorded generation behind the live one, so the next read classifies the artifact stale, and
-- the publish CAS can refuse a render older than the one the row already carries.
--
-- Same column, same reasoning and the same shape as 0200 did for field_scorecards.
--
-- Nullable: a row that somehow carries a key with no recorded generation reads as stale and re-renders
-- once, which is the safe direction. Per-tenant (office_* schemas), idempotent + guarded per schema.

DO $tenant$
DECLARE schema_name text;
BEGIN
  FOR schema_name IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^office_' ORDER BY nspname LOOP
    IF to_regclass(format('%I.weekly_reports', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format(
      'ALTER TABLE %I.weekly_reports ADD COLUMN IF NOT EXISTS pdf_content_generation timestamptz',
      schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema).
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.weekly_reports ADD COLUMN IF NOT EXISTS pdf_content_generation timestamptz;
-- TENANT_SCHEMA_END
