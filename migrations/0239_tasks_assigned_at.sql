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
-- THE OLD IMAGE HAS TO KEEP WRITING CORRECTLY, NOT MERELY KEEP WRITING. The API runs migrations before
-- it serves, so during a rolling deploy the previous API can still UPDATE assigned_to after this column
-- exists. That image cannot name assigned_at. A default protects only INSERTs; without the trigger below
-- a hand-back written by the old API retains the previous version and can be hidden forever by an old
-- acknowledgement (or mistaken for self-creation when it returns to its creator).
--
-- The default plus trigger are therefore the compatibility authority for BOTH generations:
--   * INSERT with no assigned_at: DEFAULT now(), equal to created_at's now() in the same transaction.
--   * real assigned_to change with no newer explicit stamp: advance monotonically at the database clock.
--   * new API supplies its own clock_timestamp(): keep it; the trigger must not replace a newer stamp.
--   * assigned_to re-sent unchanged: do nothing. A no-op is not a new assignment.
--
-- The one-microsecond floor matters when the stored value is ahead of the wall clock (clock correction,
-- restored data, or a deliberately future test value): every real handoff still gets a strictly newer
-- optimistic-concurrency version.
--
-- 0240's `last_assigned_by` was already live before this migration was added. Its old API writes the
-- actor on the ordinary path, but decides whether the assignee changed from an unlocked pre-read. Two
-- interleavings therefore need a database backstop while that image is still serving:
--   * it can omit last_assigned_by while its UPDATE actually moves the row, leaving the prior actor;
--   * it can supply last_assigned_by while its UPDATE is an assigned_to no-op, inventing an actor move.
-- Tenant middleware already exposes the authenticated actor as transaction-local app.current_user_id.
-- That GUC is NOT proof of a person, though: the inbound-email worker sets it to the task recipient
-- while refreshing automated rules-engine tasks. The second trigger therefore uses it only to repair
-- a REAL move on a manual task, preserves an explicit actor, and restores the old actor on every actual
-- no-op (including automated rows). It inspects the row through JSON because a clean install runs 0239
-- before 0240 adds the column; no writes are served between startup migrations, and the same guard
-- becomes active as soon as 0240 (or the atomic office provisioner) adds it.
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
-- THE COLUMN STARTS NULLABLE, DELIBERATELY. Existing rows are NULL; an old-image handoff after this file
-- commits is stamped non-NULL by the trigger. The runner then backfills ONLY rows still NULL, so it cannot
-- erase a real deploy-window handoff, and restores NOT NULL in the same per-office transaction. Setting
-- DEFAULT now() after the nullable ADD protects later inserts without filling history. Adding the column
-- as NOT NULL DEFAULT now() here would make untouched history and a newly-stamped
-- assignment indistinguishable to that backfill.

CREATE OR REPLACE FUNCTION public.stamp_task_assigned_at()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.assigned_at IS NULL
     OR (OLD.assigned_at IS NOT NULL AND NEW.assigned_at <= OLD.assigned_at) THEN
    NEW.assigned_at := GREATEST(
      pg_catalog.clock_timestamp(),
      OLD.assigned_at + interval '1 microsecond'
    );
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.stabilize_task_assignment_actor()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  old_row jsonb := to_jsonb(OLD);
  new_row jsonb := to_jsonb(NEW);
  actor_user_id text := NULLIF(current_setting('app.current_user_id', true), '');
BEGIN
  -- On a clean install 0239 precedes 0240. Keeping this function column-tolerant lets the trigger be
  -- installed now and become effective after 0240 adds last_assigned_by, without a vulnerable DDL gap.
  IF NOT (new_row ? 'last_assigned_by') THEN
    RETURN NEW;
  END IF;

  IF OLD.assigned_to IS NOT DISTINCT FROM NEW.assigned_to THEN
    -- The old API may have decided "changed" from a stale pre-read and supplied an actor even though
    -- this UPDATE does not move the row. A no-op cannot transfer who is waiting for the reply.
    IF (new_row -> 'last_assigned_by') IS DISTINCT FROM (old_row -> 'last_assigned_by') THEN
      NEW := jsonb_populate_record(
        NEW,
        jsonb_build_object('last_assigned_by', old_row -> 'last_assigned_by')
      );
    END IF;
    RETURN NEW;
  END IF;

  -- An explicit actor from either API generation is authoritative. The session actor only repairs the
  -- stale-pre-read shape on a HUMAN task. The rules engine also leaves the old actor copied through,
  -- but its rows are source='automated' and its worker GUC names the recipient, not an assigner.
  IF (new_row -> 'last_assigned_by') IS NOT DISTINCT FROM (old_row -> 'last_assigned_by')
     AND (new_row ->> 'source') = 'manual'
     AND actor_user_id IS NOT NULL THEN
    NEW := jsonb_populate_record(
      NEW,
      jsonb_build_object('last_assigned_by', actor_user_id)
    );
  END IF;

  RETURN NEW;
END;
$function$;

-- A rolling deploy has TWO provisioners. The upgraded API replays this file's tenant block, but an old
-- #1107 API container has 0240 and not 0239 baked into its image. Without a durable fence, that old
-- container can commit a brand-new office after the migration's schema scan; the 0239 ledger is then
-- present, so no later boot ever revisits the missing column or triggers.
--
-- Install the fence BEFORE scanning existing offices. CREATE TRIGGER takes a lock on public.offices:
-- an old provisioning transaction that inserted before this statement must commit before installation
-- can finish, and the scan below then sees and stages its now-visible schema. An insert that starts after
-- installation receives this deferred event. It fires only at COMMIT, after the legacy provisioner has
-- created tasks and replayed 0240, but before the incomplete office becomes visible.
CREATE OR REPLACE FUNCTION public.repair_tasks_assigned_at_after_office_provision()
RETURNS trigger
LANGUAGE plpgsql
AS $office_tasks$
DECLARE
  schema_name text := 'office_' || NEW.slug;
  tasks_relation regclass;
BEGIN
  -- createOffice accepts exactly this slug grammar. Fail closed because this trigger is attached to the
  -- table rather than only to that call site: consuming a malformed event would strand a ledger-hidden
  -- office. format(%I) still quotes the validated identifier before every dynamic statement below.
  IF NEW.slug IS NULL OR NEW.slug !~ '^[a-z][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'Cannot provision tasks.assigned_at for invalid office slug "%"', NEW.slug;
  END IF;

  tasks_relation := to_regclass(format('%I.tasks', schema_name));
  IF tasks_relation IS NULL THEN
    RAISE EXCEPTION 'Office "%" was committed before its tasks table was provisioned', NEW.slug;
  END IF;

  -- Use the SAME staged shape as the existing-office path: nullable first, then a default and both
  -- compatibility triggers. The old provisioner normally leaves this table empty, but the NULL-only
  -- created_at fill makes the fence converge correctly even if a future provisioner seeds tasks in its
  -- own still-uncommitted transaction. Suspend the two ordinary row triggers so that defensive fill
  -- cannot manufacture a user-visible audit entry or rewrite the contacts "Last touch" timestamp.
  EXECUTE format(
    'ALTER TABLE %1$I.tasks
       ADD COLUMN IF NOT EXISTS assigned_at timestamptz;
     ALTER TABLE %1$I.tasks
       ALTER COLUMN assigned_at SET DEFAULT now()',
    schema_name
  );

  EXECUTE format('DROP TRIGGER IF EXISTS stamp_tasks_assigned_at ON %I.tasks', schema_name);
  EXECUTE format(
    'CREATE TRIGGER stamp_tasks_assigned_at
       BEFORE UPDATE OF assigned_to ON %I.tasks
       FOR EACH ROW
       WHEN (OLD.assigned_to IS DISTINCT FROM NEW.assigned_to)
       EXECUTE FUNCTION public.stamp_task_assigned_at()',
    schema_name
  );

  EXECUTE format('DROP TRIGGER IF EXISTS stabilize_tasks_assignment_actor ON %I.tasks', schema_name);
  EXECUTE format(
    'CREATE TRIGGER stabilize_tasks_assignment_actor
       BEFORE UPDATE OF assigned_to ON %I.tasks
       FOR EACH ROW
       EXECUTE FUNCTION public.stabilize_task_assignment_actor()',
    schema_name
  );

  EXECUTE format('ALTER TABLE %I.tasks DISABLE TRIGGER set_tasks_updated_at', schema_name);
  EXECUTE format('ALTER TABLE %I.tasks DISABLE TRIGGER audit_tasks', schema_name);
  EXECUTE format(
    'UPDATE %I.tasks SET assigned_at = created_at WHERE assigned_at IS NULL',
    schema_name
  );
  EXECUTE format('ALTER TABLE %I.tasks ALTER COLUMN assigned_at SET NOT NULL', schema_name);
  EXECUTE format('ALTER TABLE %I.tasks ENABLE TRIGGER audit_tasks', schema_name);
  EXECUTE format('ALTER TABLE %I.tasks ENABLE TRIGGER set_tasks_updated_at', schema_name);

  RETURN NULL;
END $office_tasks$;

DROP TRIGGER IF EXISTS tasks_assigned_at_on_office_provision ON public.offices;
CREATE CONSTRAINT TRIGGER tasks_assigned_at_on_office_provision
AFTER INSERT ON public.offices
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.repair_tasks_assigned_at_after_office_provision();

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
          ADD COLUMN IF NOT EXISTS assigned_at timestamptz;

        ALTER TABLE %1$I.tasks
          ALTER COLUMN assigned_at SET DEFAULT now();
      $sql$,
      schema_name
    );

    -- DROP + CREATE makes a partially-run migration retry converge. Both are in this same transaction as
    -- ADD COLUMN, so no old API can observe the column without also getting the compatibility trigger.
    EXECUTE format('DROP TRIGGER IF EXISTS stamp_tasks_assigned_at ON %I.tasks', schema_name);
    EXECUTE format(
      'CREATE TRIGGER stamp_tasks_assigned_at
         BEFORE UPDATE OF assigned_to ON %I.tasks
         FOR EACH ROW
         WHEN (OLD.assigned_to IS DISTINCT FROM NEW.assigned_to)
         EXECUTE FUNCTION public.stamp_task_assigned_at()',
      schema_name
    );

    EXECUTE format('DROP TRIGGER IF EXISTS stabilize_tasks_assignment_actor ON %I.tasks', schema_name);
    EXECUTE format(
      'CREATE TRIGGER stabilize_tasks_assignment_actor
         BEFORE UPDATE OF assigned_to ON %I.tasks
         FOR EACH ROW
         EXECUTE FUNCTION public.stabilize_task_assignment_actor()',
      schema_name
    );

    -- Dating untouched history and restoring the final column contract is the runner step's job, one
    -- transaction per office. It must not move back into this cross-tenant transaction.
  END LOOP;
END $tenant$;

-- New tenants: the office provisioner clones the marked block (office_dallas -> new schema). No
-- backfill -- a freshly provisioned office has no task history to date.
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.tasks
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz NOT NULL DEFAULT now();

DROP TRIGGER IF EXISTS stamp_tasks_assigned_at ON office_dallas.tasks;
CREATE TRIGGER stamp_tasks_assigned_at
  BEFORE UPDATE OF assigned_to ON office_dallas.tasks
  FOR EACH ROW
  WHEN (OLD.assigned_to IS DISTINCT FROM NEW.assigned_to)
  EXECUTE FUNCTION public.stamp_task_assigned_at();

DROP TRIGGER IF EXISTS stabilize_tasks_assignment_actor ON office_dallas.tasks;
CREATE TRIGGER stabilize_tasks_assignment_actor
  BEFORE UPDATE OF assigned_to ON office_dallas.tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.stabilize_task_assignment_actor();
-- TENANT_SCHEMA_END

COMMENT ON COLUMN office_dallas.tasks.assigned_at IS
  'When this task last changed hands: set at creation, re-stamped whenever assigned_to moves. An assignment acknowledgement counts only when acknowledged_at >= assigned_at, so a task handed back to a prior assignee is announced again; and assigned_at = created_at is what separates a self-written task from one returned to its author. Migration 0239.';
