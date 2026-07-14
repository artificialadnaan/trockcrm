-- Migration 0185: durable, server-owned upload scope for evidence added while editing a submitted
-- Field Scorecard. User-editable gallery tags are intentionally not used for authorization or cleanup.
-- The state machine makes discard-vs-confirm durable across requests/processes:
--   authorized -> confirmed -> linked
--   authorized/confirmed -> discarded
-- `linked` is terminal so evidence that was ever successfully attached is never later hidden by cleanup.

DO $tenant$
DECLARE schema_name text;
BEGIN
  FOR schema_name IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^office_' ORDER BY nspname LOOP
    IF to_regclass(format('%I.field_scorecards', schema_name)) IS NULL
       OR to_regclass(format('%I.files', schema_name)) IS NULL
       OR to_regclass(format('%I.deals', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.field_scorecard_edit_uploads (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         scorecard_id uuid NOT NULL REFERENCES %I.field_scorecards(id) ON DELETE CASCADE,
         deal_id uuid NOT NULL REFERENCES %I.deals(id) ON DELETE CASCADE,
         client_upload_id varchar(64) NOT NULL,
         uploaded_by uuid NOT NULL,
         file_id uuid REFERENCES %I.files(id) ON DELETE SET NULL,
         state varchar(20) NOT NULL DEFAULT ''authorized'',
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now(),
         CONSTRAINT field_scorecard_edit_uploads_state_check
           CHECK (state IN (''authorized'', ''confirmed'', ''linked'', ''discarded'')),
         CONSTRAINT field_scorecard_edit_uploads_client_upload_key UNIQUE (client_upload_id)
       )',
      schema_name, schema_name, schema_name, schema_name
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS field_scorecard_edit_uploads_card_idx
         ON %I.field_scorecard_edit_uploads (scorecard_id)', schema_name
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS field_scorecard_edit_uploads_file_idx
         ON %I.field_scorecard_edit_uploads (file_id)', schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema).
-- TENANT_SCHEMA_START
CREATE TABLE IF NOT EXISTS office_dallas.field_scorecard_edit_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scorecard_id uuid NOT NULL REFERENCES office_dallas.field_scorecards(id) ON DELETE CASCADE,
  deal_id uuid NOT NULL REFERENCES office_dallas.deals(id) ON DELETE CASCADE,
  client_upload_id varchar(64) NOT NULL,
  uploaded_by uuid NOT NULL,
  file_id uuid REFERENCES office_dallas.files(id) ON DELETE SET NULL,
  state varchar(20) NOT NULL DEFAULT 'authorized',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT field_scorecard_edit_uploads_state_check
    CHECK (state IN ('authorized', 'confirmed', 'linked', 'discarded')),
  CONSTRAINT field_scorecard_edit_uploads_client_upload_key UNIQUE (client_upload_id)
);
CREATE INDEX IF NOT EXISTS field_scorecard_edit_uploads_card_idx
  ON office_dallas.field_scorecard_edit_uploads (scorecard_id);
CREATE INDEX IF NOT EXISTS field_scorecard_edit_uploads_file_idx
  ON office_dallas.field_scorecard_edit_uploads (file_id);
-- TENANT_SCHEMA_END
