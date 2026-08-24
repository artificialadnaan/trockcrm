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
-- ⚠️ THE TRIGGERS ARE DISABLED AROUND THE BACKFILL, for the reason 0233's header sets out at length:
-- `tasks` carries set_tasks_updated_at, the contacts list reads MAX(tasks.updated_at) straight through
-- as a contact's "Last touch", and the "Untouched 30d+" card, its drill and its aggregate are all
-- derived from that one expression. Letting the trigger fire here would stamp every contact that has
-- ever had a task with this migration's timestamp, and the original values are not recoverable.
-- audit_tasks is disabled for the same window because it writes an audit row per task, in every office,
-- for a column no person edited.

-- Existing tenants: add the column and date it from creation in every office_* schema.
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

    EXECUTE format('ALTER TABLE %1$I.tasks DISABLE TRIGGER set_tasks_updated_at', schema_name);
    EXECUTE format('ALTER TABLE %1$I.tasks DISABLE TRIGGER audit_tasks', schema_name);

    -- Guarded on the value actually changing, so a re-run against a converged schema rewrites nothing.
    EXECUTE format(
      $sql$
        UPDATE %1$I.tasks SET assigned_at = created_at
         WHERE assigned_at <> created_at;
      $sql$,
      schema_name
    );

    EXECUTE format('ALTER TABLE %1$I.tasks ENABLE TRIGGER audit_tasks', schema_name);
    EXECUTE format('ALTER TABLE %1$I.tasks ENABLE TRIGGER set_tasks_updated_at', schema_name);
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
