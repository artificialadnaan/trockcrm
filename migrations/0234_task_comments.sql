-- Migration 0234: the task closed loop — a thread on a task, and the two facts that close it.
--
-- NUMBERING PROVENANCE (0216's header explains why "highest number on disk" is the wrong test):
--   git fetch origin --prune
--   git log --all --diff-filter=AM --name-only --format= -- 'migrations/022*' 'migrations/023*'
-- Highest across ALL remote heads at authoring time: 0236 (0236_bid_due_date_report.sql). 0232
-- (marketing expense requests), 0233 (task source classification), 0235 and 0236 are all taken by
-- in-flight branches, so 0234 is the first free number this branch may claim.
--
-- WHAT THE ASK IS. Tasks get assigned and then vanish: the assigner has no surface that shows what the
-- assignee said, and no signal that they said anything. Three pieces of state answer that, and none of
-- them exist today.
--
--   task_comments        the thread itself. Flat, not threaded, and append-only. One level is what the
--                        ask describes, and ai_disconnect_case_history (0027:55-77) -- the closest
--                        existing shape in this schema -- is flat too.
--   tasks.last_reply_at  the head of that thread, denormalised. "Which of the tasks I assigned have
--   tasks.last_reply_by  been answered" has to be answerable in ONE indexed predicate over `tasks`;
--                        a correlated MAX() over task_comments on every list render is not that.
--   tasks.assigner_ack_at  how far up the thread the assigner has confirmed reading.
--
-- ⚠️ assigner_ack_at IS MONOTONIC AND IS NEVER CLEARED, AND THAT IS A CORRECTNESS PROPERTY, NOT A STYLE
-- CHOICE. The obvious design -- clear the ack whenever a new reply lands -- makes the comparison
-- `assigner_ack_at < last_reply_at` UNREACHABLE, because an ack only ever writes a timestamp at least
-- as new as the reply it acknowledges. Every "a reply after an ack re-raises the task" case would then
-- run through the IS NULL branch, the comparison could be deleted without a single test noticing, and
-- the guard would be decorative. Keeping the column monotonic and having the ack carry the timestamp
-- the client actually RENDERED also closes the read-modify-write race in the obvious design: assigner
-- loads the thread (sees R1) -> assignee posts R2 -> the assigner's ack commits now() > R2 and marks a
-- reply nobody has read as seen, forever.
--
-- NO updated_at ON task_comments, DELIBERATELY. Comments are append-only: no edit path, no delete path.
-- A column with no writer reads as "last edited" while only ever holding the insert time -- the same
-- dead-column trap disqualified_at is. If editing is ever added, it arrives with its own trigger.
--
-- THE ENUM VALUE IS THE PART THAT BREAKS PRODUCTION IF IT IS MISSING. notifications.type is a Postgres
-- enum (0001_initial.sql:92, used :715); writing an undeclared value raises
-- `invalid input value for enum notification_type`. Every reply writes a 'task_replied' in-app row from
-- the worker's task.replied handler, so a missing ALTER TYPE does not degrade the notification -- it
-- throws inside the job and takes the job with it. The DO/EXCEPTION wrapper is the precedent set by
-- 0184_won_metric_reduction_alerts.sql:12 and is what makes this file re-runnable.
--
-- ALTER TYPE ... ADD VALUE IS SAFE HERE, AND ONLY BECAUSE NOTHING BELOW USES THE VALUE. The runner
-- sends each file to client.query() as one string, i.e. one implicit transaction (server/src/
-- migrations/runner.ts:114-115). Postgres permits ADD VALUE inside a transaction block but forbids
-- USING the new value before that transaction commits. This file only creates schema, so the first use
-- is a later transaction. Do not add a seed INSERT that names 'task_replied' to this file.
--
-- NO CONCURRENT INDEX PRE-STEP. Unlike 0233, neither index here can block a hot path: task_comments is
-- brand new and empty in every schema, and tasks_creator_awaiting_ack_idx is PARTIAL on
-- `last_reply_at IS NOT NULL`, which matches zero rows on the day this runs.

-- Must come before anything that could reference it, and must not be referenced by this file at all.
DO $$
BEGIN
  ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'task_replied';
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

-- Existing tenants: create the thread table, add the three columns and build both indexes in every
-- office_* schema.
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
    -- migration (and every other tenant with it) for one incomplete schema.
    IF to_regclass(format('%I.tasks', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      $sql$
        CREATE TABLE IF NOT EXISTS %1$I.task_comments (
          id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          task_id    uuid NOT NULL REFERENCES %1$I.tasks(id) ON DELETE CASCADE,
          -- FK mirrors tasks.created_by (0001_initial.sql:691), which has one. NULL is a real value
          -- here and means the platform wrote the row (kind = 'system'), not a lost author.
          author_id  uuid REFERENCES public.users(id),
          body       text NOT NULL
                       -- `btrim(body) <> ''` would NOT catch this: btrim's default trim set is the
                       -- SPACE character only, so a body of newlines and tabs passes it. Requiring one
                       -- non-whitespace character is the rule that was actually meant.
                       CONSTRAINT task_comments_body_not_blank CHECK (body ~ '[^[:space:]]'),
          kind       varchar(20) NOT NULL DEFAULT 'reply'
                       CONSTRAINT task_comments_kind_check CHECK (kind IN ('reply', 'note', 'system')),
          -- clock_timestamp(), NOT now(). now() is transaction-START, and this column is what
          -- decides whether a reply counts as unread. Two overlapping requests are enough to lose
          -- one: T1 opens and stalls, T2 posts a reply, the assigner reads and acknowledges up to
          -- it, and only THEN does T1 commit an insert stamped with its own BEGIN -- older than the
          -- acknowledgement that never saw it, so it never re-enters "Needs your attention".
          -- Reading the wall clock at INSERT shrinks that window from the whole transaction to the
          -- gap between the insert and its commit. It does not close it entirely: nothing short of a
          -- commit-order sequence would, and that is a bigger change than this table warrants.
          created_at timestamptz NOT NULL DEFAULT clock_timestamp()
        );
      $sql$,
      schema_name
    );

    EXECUTE format(
      $sql$
        CREATE INDEX IF NOT EXISTS task_comments_task_created_idx
          ON %1$I.task_comments (task_id, created_at DESC);
      $sql$,
      schema_name
    );

    EXECUTE format(
      $sql$
        ALTER TABLE %1$I.tasks
          ADD COLUMN IF NOT EXISTS last_reply_at   timestamptz,
          ADD COLUMN IF NOT EXISTS last_reply_by   uuid REFERENCES public.users(id),
          ADD COLUMN IF NOT EXISTS assigner_ack_at timestamptz;
      $sql$,
      schema_name
    );

    -- PARTIAL on the unacked condition, not merely on last_reply_at IS NOT NULL.
    --
    -- The whole predicate behind "Needs your attention" is
    --   last_reply_at IS NOT NULL AND (assigner_ack_at IS NULL OR assigner_ack_at < last_reply_at)
    -- and an index that carries only the first conjunct leaves the second one as a post-scan filter --
    -- over every task the person has ever assigned, on every render of their list. Folding the whole
    -- predicate into the index also keeps it tiny: an acknowledged task drops OUT of the index the
    -- moment it is acknowledged, so the index only ever holds open loops.
    EXECUTE format(
      $sql$
        CREATE INDEX IF NOT EXISTS tasks_creator_awaiting_ack_idx
          ON %1$I.tasks (created_by, last_reply_at DESC)
          WHERE last_reply_at IS NOT NULL
            AND (assigner_ack_at IS NULL OR assigner_ack_at < last_reply_at);
      $sql$,
      schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: the office provisioner clones the marked block below (office_dallas -> new schema).
-- It must stay byte-for-byte equivalent to the loop above or an office created after this deploy comes
-- up without a thread table and every reply there 500s.
-- TENANT_SCHEMA_START
CREATE TABLE IF NOT EXISTS office_dallas.task_comments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id    uuid NOT NULL REFERENCES office_dallas.tasks(id) ON DELETE CASCADE,
  author_id  uuid REFERENCES public.users(id),
  body       text NOT NULL
               CONSTRAINT task_comments_body_not_blank CHECK (body ~ '[^[:space:]]'),
  kind       varchar(20) NOT NULL DEFAULT 'reply'
               CONSTRAINT task_comments_kind_check CHECK (kind IN ('reply', 'note', 'system')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS task_comments_task_created_idx
  ON office_dallas.task_comments (task_id, created_at DESC);

ALTER TABLE office_dallas.tasks
  ADD COLUMN IF NOT EXISTS last_reply_at   timestamptz,
  ADD COLUMN IF NOT EXISTS last_reply_by   uuid REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS assigner_ack_at timestamptz;

CREATE INDEX IF NOT EXISTS tasks_creator_awaiting_ack_idx
  ON office_dallas.tasks (created_by, last_reply_at DESC)
  WHERE last_reply_at IS NOT NULL
    AND (assigner_ack_at IS NULL OR assigner_ack_at < last_reply_at);
-- TENANT_SCHEMA_END

COMMENT ON COLUMN office_dallas.tasks.assigner_ack_at IS
  'How far up the task thread the ASSIGNER has confirmed reading. MONOTONIC — set to GREATEST(existing, the timestamp the client rendered) and never cleared, so `assigner_ack_at < last_reply_at` stays reachable and a reply landing mid-acknowledgement cannot be marked seen. Migration 0234.';

COMMENT ON TABLE office_dallas.task_comments IS
  'Flat, append-only thread on a task. A ''reply'' from the assignee stamps tasks.last_reply_at/last_reply_by and surfaces the task in the assigner''s "Needs your attention" bucket. No edit or delete path, hence no updated_at. Migration 0234.';
