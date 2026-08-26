-- Migration 0240: `tasks.last_assigned_by` — WHO last handed this task to somebody?
--
-- NUMBERING PROVENANCE (0216's header explains why "highest number on disk" is the wrong test):
--   git fetch origin --prune
--   git log --all --diff-filter=AM --name-only --format= -- 'migrations/023*' 'migrations/024*'
-- Taken across ALL remote heads at authoring time: 0232 (twice — marketing expenses and the
-- notification recipient registry), 0233, 0234 (this branch), 0235 and 0239 (feat/task-assignment-
-- modal), 0236, 0237 (feat/task-source-write-sites), 0238. 0240 is the first free number.
--
-- THE DEFECT. A task's reply loop delivered to `created_by`. When an admin reassigns through
-- PATCH /tasks/:id, `assigned_to` moves and the assignment email correctly names the CURRENT
-- requester as the assigner — but `created_by` never moves. So the new assignee replied and it went
-- to whoever originally typed the task, possibly months after they handed it on; and on a task the
-- system created (`created_by IS NULL`) it went to nobody at all, even though a human assignment
-- email had just gone out.
--
-- ⚠️ THREE COLUMNS, THREE DIFFERENT QUESTIONS — WRITE THEM DOWN, BECAUSE THIS TABLE IS ALREADY THE
-- CAUTIONARY TALE. `created_by`, `origin_rule` and `type` each half-answer "where did this come
-- from", which is exactly why 0233 needed a fourth column to answer it properly. These do not
-- overlap:
--     created_by         WHO TYPED IT INTO EXISTENCE.        Never moves. (0001)
--     assigned_at        WHEN it last changed hands.         (0239, feat/task-assignment-modal)
--     last_assigned_by   WHO last handed it over.            (here)
-- Checked feat/task-assignment-modal before adding this: its 0239 adds `assigned_at`, maintains its
-- timestamp, and supplies a rolling-deploy database guard for this actor from app.current_user_id;
-- 0235's task_assignment_acknowledgements records the ACKNOWLEDGER (the assignee). Neither
-- carries the actor, so this is not a second column answering a question already answered — it is the
-- identity half of the same event their timestamp describes. The two are written at the SAME sites so
-- they can never disagree about whether an assignment happened.
--
-- ⚠️ NO BACKFILL, AND THAT IS A DESIGN DECISION RATHER THAN AN OMISSION. Readers resolve the assigner
-- as COALESCE(last_assigned_by, created_by): until a task changes hands the person who created it IS
-- the person who assigned it, so `created_by` is already the correct answer for every historical row.
-- Writing that same value into a new column would rewrite every task in every office to tell us what
-- we already knew — and `tasks` carries set_tasks_updated_at, which the contacts list reads through
-- as "Last touch", so a backfill here is the one operation on this table with a genuinely
-- irreversible failure mode (see 0233's header). Not doing it is strictly safer than doing it
-- carefully. NULL means "never reassigned", which is a fact worth being able to read.
--
-- THE INDEX MATCHES THE PREDICATE, EXPRESSION AND ALL. /tasks/awaiting-me scopes by the resolved
-- assigner, so the index is on the same COALESCE expression the query uses; indexing the bare column
-- would leave the resolution to a post-scan filter over every task the person ever created. COALESCE
-- over two plain columns is IMMUTABLE, so it is indexable.

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
    -- Skip a partially-provisioned office rather than aborting every tenant for one incomplete schema.
    IF to_regclass(format('%I.tasks', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      $sql$
        ALTER TABLE %1$I.tasks
          ADD COLUMN IF NOT EXISTS last_assigned_by uuid REFERENCES public.users(id);
      $sql$,
      schema_name
    );

    EXECUTE format(
      $sql$
        CREATE INDEX IF NOT EXISTS tasks_assigner_awaiting_ack_idx
          ON %1$I.tasks (COALESCE(last_assigned_by, created_by), last_reply_at DESC)
          WHERE last_reply_at IS NOT NULL
            AND (assigner_ack_at IS NULL OR assigner_ack_at < last_reply_at);
      $sql$,
      schema_name
    );

    -- 0234's creator-scoped index is superseded by the expression above. Dropped rather than left
    -- behind: nothing reads it now, and every task write would go on maintaining it.
    EXECUTE format('DROP INDEX IF EXISTS %1$I.tasks_creator_awaiting_ack_idx', schema_name);
  END LOOP;
END $tenant$;

-- New tenants: the office provisioner clones the marked block below.
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.tasks
  ADD COLUMN IF NOT EXISTS last_assigned_by uuid REFERENCES public.users(id);

CREATE INDEX IF NOT EXISTS tasks_assigner_awaiting_ack_idx
  ON office_dallas.tasks (COALESCE(last_assigned_by, created_by), last_reply_at DESC)
  WHERE last_reply_at IS NOT NULL
    AND (assigner_ack_at IS NULL OR assigner_ack_at < last_reply_at);

DROP INDEX IF EXISTS office_dallas.tasks_creator_awaiting_ack_idx;
-- TENANT_SCHEMA_END

COMMENT ON COLUMN office_dallas.tasks.last_assigned_by IS
  'WHO last handed this task to somebody — stamped only when assigned_to actually MOVES, alongside assigned_at (migration 0239), so the pair cannot disagree about whether an assignment happened. NULL means the task has never been reassigned, in which case the assigner is created_by; readers resolve COALESCE(last_assigned_by, created_by). Distinct from created_by, which answers "who typed this into existence" and never moves: after a reassignment they differ, and it is the RESOLVED identity the reply loop delivers to and accepts acknowledgements from. Migration 0240.';
