-- Migration 0202: the corrective-action APPROVAL gate.
--
-- Until now a corrective action auto-closed the moment the last flagged item was answered: the item flipped
-- to 'resolved', no 'open' rows remained, and the card was written 'corrective_action_closed'. Nobody
-- reviewed the work. This migration adds the review gate between submission and closure.
--
-- Four changes, all per-tenant (office_* schemas), idempotent + guarded per schema:
--
--   1. RENAME the item state 'resolved' -> 'submitted'. It already meant "the responder answered", which is
--      exactly what 'submitted' means now; the value is simply no longer terminal. No reinterpretation of
--      data, only a name that stops implying finality. 'approved' and 'rejected' join it as new values.
--
--   2. WIDEN scorecard_corrective_actions_open_idx to the OUTSTANDING set ('open','rejected'). A rejected
--      item is still the responder's to fix, so every "is anything left to do?" query must see it. The index
--      backs the closure check; leaving it at 'open' alone would let a card close with rejected work in it.
--      Renamed to _outstanding_idx so the name cannot imply the narrower predicate.
--
--   3. NEW scorecard_corrective_action_events — the append-only thread that documents the full back-and-forth
--      (submitted -> rejected + reason -> resubmitted -> approved). The existing single-valued response
--      columns on scorecard_corrective_actions hold only the LATEST attempt, so a reject-then-resubmit
--      overwrites them; without this table the PDF and the CRM could only ever show the final round.
--
--   4. field_scorecard_photos.corrective_action_event_id — so "the photos from attempt 2" stays answerable
--      after attempt 3. The existing corrective_action_id link is unchanged and still means "photos for this
--      item" in aggregate; the new column is nullable and null for every pre-approval response photo.
--
-- The CARD state 'corrective_action_submitted' (27 chars) needs no DDL: field_scorecards.status is already
-- varchar(30) after 0192. 'corrective_action_closed' keeps its name even though it now means APPROVED —
-- renaming it would churn the QC dashboard, the reports service, the client badge and every runtime fixture
-- for no user-visible gain.

DO $tenant$
DECLARE schema_name text;
BEGIN
  FOR schema_name IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^office_' ORDER BY nspname LOOP
    IF to_regclass(format('%I.scorecard_corrective_actions', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    -- 1. resolved -> submitted. Idempotent: a rerun matches no rows.
    EXECUTE format(
      'UPDATE %I.scorecard_corrective_actions SET status = ''submitted'' WHERE status = ''resolved''',
      schema_name
    );

    -- 2. The outstanding-set index. Drop the narrower one only after the wider one exists.
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS scorecard_corrective_actions_outstanding_idx
         ON %I.scorecard_corrective_actions (scorecard_id)
       WHERE status IN (''open'', ''rejected'')',
      schema_name
    );
    EXECUTE format(
      'DROP INDEX IF EXISTS %I.scorecard_corrective_actions_open_idx',
      schema_name
    );

    -- 3. The append-only event thread.
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.scorecard_corrective_action_events (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         -- Monotonic insertion order. created_at ALONE is not a stable sort: several events can be written
         -- inside one transaction and share a timestamp to the microsecond, and the uuid PK is random, so
         -- the thread would render in an arbitrary order — for an audit trail whose whole value is the
         -- sequence of what happened, that is a correctness bug, not a cosmetic one.
         seq bigserial NOT NULL,
         corrective_action_id uuid NOT NULL
           REFERENCES %I.scorecard_corrective_actions(id) ON DELETE CASCADE,
         -- Denormalized so the whole thread for a card is one indexed read, and so the row survives as a
         -- scorecard-scoped record even as items are added/removed by an edit.
         scorecard_id uuid NOT NULL
           REFERENCES %I.field_scorecards(id) ON DELETE CASCADE,
         event_type text NOT NULL
           CHECK (event_type IN (''submitted'', ''approved'', ''rejected'')),
         -- Null for a token responder, who has no CRM user id.
         actor_user_id uuid,
         -- Captured at write time so a later rename, archive or role change cannot rewrite history.
         actor_name text,
         actor_email text,
         -- The response text, or the rejection reason. Required for a rejection: "what to fix" is the
         -- entire point of sending it back.
         comment text,
         CONSTRAINT scorecard_corrective_action_events_reject_needs_comment
           CHECK (event_type <> ''rejected'' OR (comment IS NOT NULL AND length(btrim(comment)) > 0)),
         created_at timestamptz NOT NULL DEFAULT now()
       )',
      schema_name, schema_name, schema_name
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS scorecard_corrective_action_events_scorecard_idx
         ON %I.scorecard_corrective_action_events (scorecard_id, seq)',
      schema_name
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS scorecard_corrective_action_events_item_idx
         ON %I.scorecard_corrective_action_events (corrective_action_id, seq)',
      schema_name
    );

    -- 4. Per-attempt photo attribution.
    EXECUTE format(
      'ALTER TABLE %I.field_scorecard_photos
         ADD COLUMN IF NOT EXISTS corrective_action_event_id uuid
         REFERENCES %I.scorecard_corrective_action_events(id) ON DELETE SET NULL',
      schema_name, schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema).
-- TENANT_SCHEMA_START
UPDATE office_dallas.scorecard_corrective_actions SET status = 'submitted' WHERE status = 'resolved';
CREATE INDEX IF NOT EXISTS scorecard_corrective_actions_outstanding_idx
  ON office_dallas.scorecard_corrective_actions (scorecard_id)
  WHERE status IN ('open', 'rejected');
DROP INDEX IF EXISTS office_dallas.scorecard_corrective_actions_open_idx;
CREATE TABLE IF NOT EXISTS office_dallas.scorecard_corrective_action_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigserial NOT NULL,
  corrective_action_id uuid NOT NULL
    REFERENCES office_dallas.scorecard_corrective_actions(id) ON DELETE CASCADE,
  scorecard_id uuid NOT NULL
    REFERENCES office_dallas.field_scorecards(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('submitted', 'approved', 'rejected')),
  actor_user_id uuid,
  actor_name text,
  actor_email text,
  comment text,
  CONSTRAINT scorecard_corrective_action_events_reject_needs_comment
    CHECK (event_type <> 'rejected' OR (comment IS NOT NULL AND length(btrim(comment)) > 0)),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scorecard_corrective_action_events_scorecard_idx
  ON office_dallas.scorecard_corrective_action_events (scorecard_id, seq);
CREATE INDEX IF NOT EXISTS scorecard_corrective_action_events_item_idx
  ON office_dallas.scorecard_corrective_action_events (corrective_action_id, seq);
ALTER TABLE office_dallas.field_scorecard_photos
  ADD COLUMN IF NOT EXISTS corrective_action_event_id uuid
  REFERENCES office_dallas.scorecard_corrective_action_events(id) ON DELETE SET NULL;
-- TENANT_SCHEMA_END
