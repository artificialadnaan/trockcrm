-- Migration 0239: `tasks.assigned_at` — WHEN did this task last change hands?
--
-- NUMBERING PROVENANCE (0216's header explains why "highest number on disk" is the wrong test):
--   git fetch origin --prune
--   git log --all --diff-filter=AM --name-only --format= -- 'migrations/023*' 'migrations/024*'
-- Across all remote heads plus the in-flight worktrees at authoring time: 0232 (twice), 0233, 0234
-- (task comments), 0235 (this branch), 0236, 0237, 0238. 0239 is the first free number.
--
-- WHY. Acknowledgement of a task assignment is keyed (task_id, user_id), which records THAT a person
-- was told about a task and cannot record WHICH assignment they were told about. Two review findings
-- turned out to be the same gap seen from opposite ends:
--
--   * A task handed BACK to a prior assignee is covered by the acknowledgement they gave the first
--     time round, so they are never told about the second handoff.
--   * A task handed back to its CREATOR now has created_by = assigned_to, which is byte-identical to a
--     task somebody wrote for themselves — and those are deliberately suppressed.
--
-- Both are answered by the same missing fact: an assignment happens at a MOMENT. With assigned_at, an
-- acknowledgement is only good for the assignment it was made against (acknowledged_at >= assigned_at),
-- and a task that has never changed hands still has assigned_at = created_at, which is exactly what
-- separates self-creation from a return.
--
-- NOT NULL DEFAULT now(), for the same deploy-window reason 0233 gives for tasks.source: the API runs
-- migrations and the worker does not, and they are separate Railway services. A default means a worker
-- still on the old image can INSERT without naming the column instead of failing every rules-engine
-- write on `column "assigned_at" does not exist`.
--
-- THE BACKFILL USES created_at, NOT now(), AND THAT DIRECTION IS DELIBERATE. History does not record
-- when a task changed hands, so any value is a guess; created_at is the earliest defensible one. Being
-- too EARLY is the safe error: an existing acknowledgement still counts, and nothing pops. Backfilling
-- to now() would post-date every acknowledgement in the table and re-notify the entire company about
-- work they have already seen — the same failure 0235's own seed exists to prevent. Tasks reassigned
-- before this deploy therefore keep whatever acknowledgement they had; only handoffs from here on are
-- distinguished.
--
-- ⚠️ THE BACKFILL IS NOT IN THIS FILE, AND CANNOT BE.
-- See server/src/migrations/per-office-step.ts for the rule and the mechanism, and
-- server/src/migrations/tasks-assigned-at-backfill.ts for this migration's configuration of it. In
-- short: runner.ts sends each .sql as ONE client.query(), so a DO block looping every office holds the
-- first office's locks until the LAST office finishes — and this backfill has to DISABLE
-- set_tasks_updated_at and audit_tasks around itself, which takes a lock conflicting with every task
-- write. Inside this file that would block task creation and edits across ALL tenants during API
-- startup. Per-office transactions are not expressible in a migration file at all, so it is not
-- something the SQL can be rearranged to fix. 0233 hit the same wall first; this is the same mechanism
-- with a second caller, not a second mechanism.
--
-- What remains below is the ADD COLUMN, which is metadata-only in PG11+ and effectively instant, and
-- which has to stay here regardless: the office provisioner replays the marked block for schemas
-- created after this deploy.

-- Existing tenants: add the column in every office_* schema. Dating the existing rows from their
-- creation happens in the runner step afterwards, per office.
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
    -- Skip a partially-provisioned office schema rather than aborting this migration, and every other
    -- tenant with it, for one incomplete schema.
    IF to_regclass(format('%I.tasks', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      $sql$
        ALTER TABLE %1$I.tasks
          ADD COLUMN IF NOT EXISTS assigned_at timestamptz NOT NULL DEFAULT now();
      $sql$,
      schema_name
    );

    -- Nothing else here. Dating the existing rows is the runner step's job, one transaction per office.
  END LOOP;
END $tenant$;

-- New tenants: the office provisioner clones the marked block (office_dallas -> new schema). No
-- backfill -- a freshly provisioned office has no task history to date.
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.tasks
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz NOT NULL DEFAULT now();
-- TENANT_SCHEMA_END

COMMENT ON COLUMN office_dallas.tasks.assigned_at IS
  'When this task last changed hands: set at creation, re-stamped whenever assigned_to moves. An assignment acknowledgement counts only when acknowledged_at >= assigned_at, so a task handed back to a prior assignee is announced again; and assigned_at = created_at is what separates a self-written task from one returned to its author. Migration 0239.';
