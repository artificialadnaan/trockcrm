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

    -- 1. resolved -> submitted or approved, depending on what the card's outcome ALREADY was.
    --
    -- A blanket rename to 'submitted' is wrong for history. Under the old model an answered item closed the
    -- card immediately, so every item on a card that is already corrective_action_closed was, in effect,
    -- accepted -- nobody is going to review it now. Renaming those to 'submitted' would put every
    -- historically closed card back into the approver's queue: the item-derived card status recomputes to
    -- corrective_action_submitted the next time anything touches the card, resurrecting finished work.
    --
    -- So: items on an already-CLOSED card become 'approved'; items on a card still in flight become
    -- 'submitted', which is genuinely where they are. Idempotent -- a rerun matches no rows.
    EXECUTE format(
      'UPDATE %I.scorecard_corrective_actions ca
          SET status = CASE
                         WHEN sc.status = ''corrective_action_closed'' THEN ''approved''
                         ELSE ''submitted''
                       END
         FROM %I.field_scorecards sc
        WHERE sc.id = ca.scorecard_id
          AND ca.status = ''resolved''',
      schema_name, schema_name
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

    -- 5. SEED the thread from responses that predate it.
    --
    -- Without this, every corrective action answered before this deploy renders an EMPTY thread in the PDF
    -- and the CRM, because the thread is now the source for that record while their response only ever
    -- existed in the single-valued columns above. A historical response is a real event; it just happened
    -- before there was a table to record it in. Backdated to responded_at, NOT now(), so the thread does not
    -- claim every old fix was submitted at deploy time.
    --
    -- Idempotent via NOT EXISTS: a rerun, or an item that has since accrued real events, is skipped.
    EXECUTE format(
      'INSERT INTO %I.scorecard_corrective_action_events
         (corrective_action_id, scorecard_id, event_type, actor_user_id, actor_name, actor_email,
          comment, created_at)
       SELECT ca.id, ca.scorecard_id, ''submitted'', ca.responded_by_user_id, ca.responder_name,
              ca.responder_email, ca.response_comment, COALESCE(ca.responded_at, ca.updated_at, now())
         FROM %I.scorecard_corrective_actions ca
        WHERE ca.status <> ''open''
          AND NOT EXISTS (
            SELECT 1 FROM %I.scorecard_corrective_action_events e
             WHERE e.corrective_action_id = ca.id
          )',
      schema_name, schema_name, schema_name
    );

    -- Attribute existing response photos to that seeded event, but ONLY for an item whose thread is that
    -- single event — anything with real history is left alone rather than guessed at.
    EXECUTE format(
      'UPDATE %I.field_scorecard_photos p
          SET corrective_action_event_id = e.id
         FROM %I.scorecard_corrective_action_events e
        WHERE e.corrective_action_id = p.corrective_action_id
          AND p.corrective_action_event_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM %I.scorecard_corrective_action_events e2
             WHERE e2.corrective_action_id = e.corrective_action_id AND e2.seq <> e.seq
          )',
      schema_name, schema_name, schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema).
-- TENANT_SCHEMA_START
UPDATE office_dallas.scorecard_corrective_actions ca
   SET status = CASE
                  WHEN sc.status = 'corrective_action_closed' THEN 'approved'
                  ELSE 'submitted'
                END
  FROM office_dallas.field_scorecards sc
 WHERE sc.id = ca.scorecard_id
   AND ca.status = 'resolved';
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
INSERT INTO office_dallas.scorecard_corrective_action_events
  (corrective_action_id, scorecard_id, event_type, actor_user_id, actor_name, actor_email,
   comment, created_at)
SELECT ca.id, ca.scorecard_id, 'submitted', ca.responded_by_user_id, ca.responder_name,
       ca.responder_email, ca.response_comment, COALESCE(ca.responded_at, ca.updated_at, now())
  FROM office_dallas.scorecard_corrective_actions ca
 WHERE ca.status <> 'open'
   AND NOT EXISTS (
     SELECT 1 FROM office_dallas.scorecard_corrective_action_events e
      WHERE e.corrective_action_id = ca.id
   );
UPDATE office_dallas.field_scorecard_photos p
   SET corrective_action_event_id = e.id
  FROM office_dallas.scorecard_corrective_action_events e
 WHERE e.corrective_action_id = p.corrective_action_id
   AND p.corrective_action_event_id IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM office_dallas.scorecard_corrective_action_events e2
      WHERE e2.corrective_action_id = e.corrective_action_id AND e2.seq <> e.seq
   );
-- TENANT_SCHEMA_END
