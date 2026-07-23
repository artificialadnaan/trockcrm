-- Migration 0195: durable, UNFORGEABLE ownership ledger for corrective-action RESPONSE-photo uploads.
-- Per-tenant (office_* schemas). One row per file created through the token/session-scoped corrective-action
-- upload flow (confirmCorrectiveActionUpload inserts it right after the files row is created).
--
-- Why this exists: discardCorrectiveActionUpload used to prove a file came from this flow by its
-- original_filename prefix (`corrective-action-…`). But the generic upload API accepts a caller-supplied
-- originalFilename, so that prefix is FORGEABLE — an authorized responder could craft a look-alike name and
-- soft-delete any other unattached file on the deal. This server-set ledger row cannot be forged via the
-- generic requestUploadUrl/updateFile paths (they never write this table), so discard gates on an EXISTS here
-- (file_id + scorecard_id) instead of the filename.
--
-- file_id is the PRIMARY KEY (one ledger row per file) with an FK to files(id) ON DELETE CASCADE, so a hard
-- file delete cleans the ledger; scorecard_id -> field_scorecards(id) ON DELETE CASCADE cleans the ledger when
-- the scorecard is removed. New/empty tables → a plain CREATE INDEX is instant here (no CONCURRENTLY, which
-- can't run in the migration's transaction block).

DO $tenant$
DECLARE schema_name text;
BEGIN
  FOR schema_name IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^office_' ORDER BY nspname LOOP
    IF to_regclass(format('%I.field_scorecards', schema_name)) IS NULL
       OR to_regclass(format('%I.files', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.scorecard_corrective_action_uploads (
         file_id uuid PRIMARY KEY REFERENCES %I.files(id) ON DELETE CASCADE,
         scorecard_id uuid NOT NULL REFERENCES %I.field_scorecards(id) ON DELETE CASCADE,
         created_at timestamptz NOT NULL DEFAULT now()
       )',
      schema_name, schema_name, schema_name
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS scorecard_corrective_action_uploads_scorecard_idx
         ON %I.scorecard_corrective_action_uploads (scorecard_id)', schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema).
-- TENANT_SCHEMA_START
CREATE TABLE IF NOT EXISTS office_dallas.scorecard_corrective_action_uploads (
  file_id uuid PRIMARY KEY REFERENCES office_dallas.files(id) ON DELETE CASCADE,
  scorecard_id uuid NOT NULL REFERENCES office_dallas.field_scorecards(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scorecard_corrective_action_uploads_scorecard_idx
  ON office_dallas.scorecard_corrective_action_uploads (scorecard_id);
-- TENANT_SCHEMA_END
