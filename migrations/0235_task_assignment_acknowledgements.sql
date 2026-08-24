-- Migration 0235: `task_assignment_acknowledgements` — has this person SEEN this assignment yet?
--
-- NUMBERING PROVENANCE (0216's header explains why "highest number on disk" is the wrong test):
--   git fetch origin --prune
--   git log --all --diff-filter=AM --name-only --format= -- 'migrations/022*' 'migrations/023*'
-- Across ALL remote heads at authoring time that returns 0232 (marketing expense requests), 0233 (task
-- source classification, this branch's base) and 0236 (bid due date report, already on its own head).
-- 0234 is reserved by an in-flight branch that has not been pushed. 0235 is the first free number, and
-- it is deliberately BELOW 0236: the two touch nothing in common, and the runner orders by filename, so
-- a lower number here only means this file applies first.
--
-- WHY A TABLE AND NOT A FLAG ON `tasks`. Acknowledgement is per (task, PERSON), not per task. A task
-- reassigned from Alice to Bob has been seen by Alice and not by Bob, and a boolean on the row cannot
-- hold both answers -- it would either re-pop for Alice forever or never pop for Bob. It also has to
-- survive a new device, a cleared browser profile and a second browser, which is what rules out
-- sessionStorage: this exists so "I never saw that assignment" is answerable from the database.
--
-- ⚠️ THE SEED AT THE BOTTOM OF THE LOOP IS THE MOST IMPORTANT STATEMENT IN THIS FILE.
-- The modal's query treats "no ack row" as "never shown". An empty table therefore means the ENTIRE
-- history of open assignments is unshown, and the modal serves them five at a time: a user holding 200
-- open tasks would meet an interrupting dialog on roughly forty consecutive logins, showing work they
-- have known about for months. Nothing about that failure is visible in a test that seeds its own rows,
-- and nothing about it is visible on a dev database with nine tasks in it. Seeding every ALREADY-PENDING
-- assignment as acknowledged at migration time is what makes the feature mean "new", which is the whole
-- ask. Only assignments created after this deploy pop.
--
-- The seed is keyed on `assigned_to`, not `created_by`: the row records who was shown the assignment.
--
-- ⚠️ THE STATUS FILTER HERE AND THE ONE IN THE ELIGIBILITY PREDICATE ARE ONE DECISION IN TWO LANGUAGES.
-- The predicate (server/src/modules/tasks/pending-assignment-predicate.ts) treats a task as a FIRST-TIME
-- assignment in any non-terminal status -- pending, in_progress, waiting_on, blocked -- because a
-- reassignment does not reset status, so active work handed to a new person arrives as in_progress. If
-- this seed covered only 'pending', every in-flight task in production would be reclassified as brand
-- new on the morning of the deploy and they would all pop at once, five per login, which is precisely
-- the failure this backfill exists to prevent. So the seed is deliberately WIDER than any single branch
-- of the predicate: everything that is not terminal.
--
-- Seeding more than the predicate can reach is inert (an ack row for a completed task is never read);
-- seeding less is a deploy-day incident. The relationship is asserted by executing both halves against
-- one database in tests/modules/tasks/backfill-covers-the-predicate.runtime.test.ts rather than by
-- matching the two WHERE clauses by eye. Terminal rows are still excluded so the filter is a real
-- filter -- a blanket copy of the table would pass every "nothing pre-existing pops" assertion while
-- hiding the fact that no filter was ever written.
--
-- NO TRIGGER-DISABLE WRAPPER HERE, unlike 0233. That file had to disable set_tasks_updated_at because it
-- UPDATEd `tasks`, and tasks.updated_at is read straight through as a contact's "Last touch". This
-- migration only INSERTs into a brand-new table and never writes a `tasks` row at all, so no trigger on
-- `tasks` can fire and nothing derived from tasks.updated_at moves.
--
-- ON DELETE CASCADE on task_id, and no FK on user_id. The task FK is same-schema and keeps ack rows from
-- outliving the task they describe. `user_id` points at public.users, which is cross-schema and is not
-- referenced by any other tenant table in this codebase either (tasks.assigned_to is a bare uuid); a
-- deactivated user's ack rows are harmless because the query is scoped to the caller.

-- Existing tenants: create the table, index it, and seed it in every office_* schema.
DO $tenant$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname LIKE 'office\_%' ESCAPE '\'
    ORDER BY nspname
  LOOP
    -- Skip a partially-provisioned office schema that has no tasks table yet, rather than aborting this
    -- migration (and every other tenant with it) for one incomplete schema. The FK below would fail on
    -- such a schema, so this guard is load-bearing, not defensive decoration.
    IF to_regclass(format('%I.tasks', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      $sql$
        CREATE TABLE IF NOT EXISTS %1$I.task_assignment_acknowledgements (
          id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          task_id         uuid NOT NULL REFERENCES %1$I.tasks(id) ON DELETE CASCADE,
          user_id         uuid NOT NULL,
          acknowledged_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT task_assignment_ack_uq UNIQUE (task_id, user_id)
        );
      $sql$,
      schema_name
    );

    EXECUTE format(
      $sql$
        CREATE INDEX IF NOT EXISTS task_assignment_ack_user_idx
          ON %1$I.task_assignment_acknowledgements (user_id, acknowledged_at DESC);
      $sql$,
      schema_name
    );

    -- THE SEED. See the header. ON CONFLICT DO NOTHING makes a re-run against a restored dump a no-op
    -- rather than a unique violation, and keeps a hand replay from resetting acknowledged_at on rows a
    -- person has genuinely acknowledged since.
    EXECUTE format(
      $sql$
        INSERT INTO %1$I.task_assignment_acknowledgements (task_id, user_id, acknowledged_at)
        SELECT id, assigned_to, now()
          FROM %1$I.tasks
         WHERE status NOT IN ('completed', 'dismissed')
        ON CONFLICT (task_id, user_id) DO NOTHING;
      $sql$,
      schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: the office provisioner clones the marked block below (office_dallas -> new schema). No
-- seed there -- a freshly provisioned office has no assignment history to mark as already-seen.
-- TENANT_SCHEMA_START
CREATE TABLE IF NOT EXISTS office_dallas.task_assignment_acknowledgements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id         uuid NOT NULL REFERENCES office_dallas.tasks(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL,
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_assignment_ack_uq UNIQUE (task_id, user_id)
);

CREATE INDEX IF NOT EXISTS task_assignment_ack_user_idx
  ON office_dallas.task_assignment_acknowledgements (user_id, acknowledged_at DESC);
-- TENANT_SCHEMA_END

COMMENT ON TABLE office_dallas.task_assignment_acknowledgements IS
  'One row per (task, person) recording that the login modal has shown this person this assignment. Absence of a row means "never shown", so migration 0235 seeds every task that was already pending at deploy time -- without that seed the modal replays the entire backlog five tasks at a time. Urgent/high/overdue tasks re-show regardless of the row until they leave status pending. Migration 0235.';
