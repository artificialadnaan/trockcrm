-- Migration 0190: corrective-action follow-up for below-band scorecards.
-- Per-tenant (office_* schemas). Seeds one scorecard_corrective_actions row per flagged item when a scorecard
-- trips the corrective-action band; the scorecard's status walks submitted -> corrective_action_open ->
-- corrective_action_closed. See docs/superpowers/specs/2026-07-22-scorecard-corrective-actions-design.md.
--
-- Also widens field_scorecards.status from varchar(20) to varchar(30): the new status values
-- ('corrective_action_open' = 22 chars, 'corrective_action_closed' = 24 chars) do not fit varchar(20).
-- field_scorecards.status has no CHECK constraint, so only the column length changes here; the new
-- allowed values are enforced in application code.

DO $tenant$
DECLARE schema_name text;
BEGIN
  FOR schema_name IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^office_' ORDER BY nspname LOOP
    IF to_regclass(format('%I.field_scorecards', schema_name)) IS NULL
       OR to_regclass(format('%I.field_scorecard_photos', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE %I.field_scorecards ALTER COLUMN status TYPE varchar(30)',
      schema_name
    );

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.scorecard_corrective_actions (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         scorecard_id uuid NOT NULL REFERENCES %I.field_scorecards(id) ON DELETE CASCADE,
         item_type text NOT NULL CHECK (item_type IN (''action_item'', ''critical_deficiency'')),
         item_ref text NOT NULL,
         item_label text NOT NULL,
         status text NOT NULL DEFAULT ''open'' CHECK (status IN (''open'', ''resolved'')),
         response_comment text,
         responded_by_user_id uuid,
         responder_name text,
         responder_email text,
         responded_at timestamptz,
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now(),
         CONSTRAINT scorecard_corrective_actions_scorecard_item_key
           UNIQUE (scorecard_id, item_type, item_ref)
       )',
      schema_name, schema_name
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS scorecard_corrective_actions_scorecard_idx
         ON %I.scorecard_corrective_actions (scorecard_id)', schema_name
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS scorecard_corrective_actions_open_idx
         ON %I.scorecard_corrective_actions (scorecard_id) WHERE status = ''open''', schema_name
    );
    EXECUTE format(
      'ALTER TABLE %I.field_scorecard_photos
         ADD COLUMN IF NOT EXISTS corrective_action_id uuid
         REFERENCES %I.scorecard_corrective_actions(id) ON DELETE SET NULL',
      schema_name, schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema).
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.field_scorecards ALTER COLUMN status TYPE varchar(30);
CREATE TABLE IF NOT EXISTS office_dallas.scorecard_corrective_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scorecard_id uuid NOT NULL REFERENCES office_dallas.field_scorecards(id) ON DELETE CASCADE,
  item_type text NOT NULL CHECK (item_type IN ('action_item', 'critical_deficiency')),
  item_ref text NOT NULL,
  item_label text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  response_comment text,
  responded_by_user_id uuid,
  responder_name text,
  responder_email text,
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scorecard_corrective_actions_scorecard_item_key
    UNIQUE (scorecard_id, item_type, item_ref)
);
CREATE INDEX IF NOT EXISTS scorecard_corrective_actions_scorecard_idx
  ON office_dallas.scorecard_corrective_actions (scorecard_id);
CREATE INDEX IF NOT EXISTS scorecard_corrective_actions_open_idx
  ON office_dallas.scorecard_corrective_actions (scorecard_id) WHERE status = 'open';
ALTER TABLE office_dallas.field_scorecard_photos
  ADD COLUMN IF NOT EXISTS corrective_action_id uuid
  REFERENCES office_dallas.scorecard_corrective_actions(id) ON DELETE SET NULL;
-- TENANT_SCHEMA_END
