-- Migration 0233: `tasks.source` — did a PERSON create this task, or did the system?
--
-- NUMBERING PROVENANCE (0216's header explains why "highest number on disk" is the wrong test):
--   git fetch origin --prune
--   git log --all --diff-filter=AM --name-only --format= -- 'migrations/022*' 'migrations/023*'
-- Highest across ALL remote heads at authoring time: 0231 (0231_weekly_report_views.sql). 0232 is taken
-- by an in-flight branch that has not merged yet, so 0233 is the first free number. The index this
-- column needs is 0237 — see that file for why it is not here.
--
-- WHY A COLUMN AND NOT A QUERY. The tasks list is drowning in machine-generated work and people want to
-- filter it, which needs a reliable "who made this" discriminator. Every column already on the table
-- fails as one:
--   * `type = 'manual'`   — the AI-disconnect cron writes type 'manual' on a machine task, and the New
--                           Task form sends 'manual' too. The value is genuinely ambiguous.
--   * `created_by IS NULL`— the email-assignment queue and the estimate-revision router both stamp a
--                           REAL human on created_by for a task no human asked for.
--   * `origin_rule`       — closest to honest, and it is what this backfill leans on, but reassignment
--                           tasks carry a NULL origin_rule while being just as machine-made.
-- So the answer has to be recorded at write time. This migration adds the column; the classification of
-- existing rows is a runner step (see the invariant below), and the write sites that set it explicitly
-- land next.
--
-- DEFAULT 'automated', DELIBERATELY. New rows all get an explicit value from application code, so the
-- default only governs rows nothing else identifies. Automated is both the overwhelming majority and the
-- safer wrong answer: a machine task misfiled as manual pollutes exactly the view this feature exists to
-- clean, whereas a hand-typed task misfiled as automated is still visible in the default All tab.
--
-- THE DEFAULT ALSO COVERS THE DEPLOY WINDOW. The API runs migrations, the worker does not
-- (Dockerfile.worker has no migrate step) and they are separate Railway services. Keeping a DEFAULT means
-- a worker still on the old image can INSERT without naming the column instead of failing every
-- rules-engine and cron task write on `column "source" does not exist`. A follow-up PR drops the default
-- once every write site is confirmed deployed, so a NEW write site that forgets the column fails loudly
-- rather than silently filing its rows as automated.
--
-- ⚠️ THE INVARIANT, AND IT APPLIES TO EVERY FUTURE MIGRATION THAT TOUCHES THIS TABLE:
--   NOTHING THAT TAKES A LOCK ON `tasks` MAY RUN INSIDE A MIGRATION FILE'S SINGLE TRANSACTION
--   ACROSS EVERY OFFICE.
-- runner.ts sends each .sql file as ONE client.query(sql), so a DO block looping every office_% schema
-- holds every lock it takes until the LAST office finishes. Per-tenant transactions are not
-- expressible inside a migration file at all — you cannot fix that by rearranging the SQL. `tasks` is
-- written by the rules engine, the email queue, two crons, deal reassignment and every person using the
-- New Task form, so a lock held across tenants means task writes progressively blocking in every
-- office, on deploy, potentially past the app's 30/45s timeouts.
--
-- This file therefore contains ONLY the additive part: ADD COLUMN (metadata-only in PG11+, so its brief
-- ACCESS EXCLUSIVE cannot be avoided and costs microseconds) and the CHECK. The two things that would
-- hold real locks live in runner steps that take one transaction PER OFFICE and release it before
-- moving on:
--   * the classification backfill, which must disable set_tasks_updated_at and audit_tasks around
--     itself   -> server/src/migrations/task-source-backfill.ts, built on the REUSABLE mechanism in
--                  server/src/migrations/per-office-step.ts (use that for any future migration here)
--   * the index, which must be built CONCURRENTLY                -> 0237 + task-source-index.ts
--
-- WHY THE BACKFILL SUSPENDS THOSE TRIGGERS AT ALL (the reason it cannot simply run here). `tasks`
-- carries set_tasks_updated_at (0001:858 -> set_updated_at at 0001:368), which sets
-- NEW.updated_at = NOW() on every UPDATE, unconditionally. The contacts list reads
-- MAX(tasks.updated_at) straight through as a contact's "Last touch" (contacts/service.ts
-- buildContactLastTouchAtSql), and the "Untouched 30d+" card, its ?card=untouched drill and the
-- aggregate count are ALL derived from that one expression. A backfill that let the trigger fire would
-- stamp every contact that has ever had a task with this migration's timestamp: the sort would
-- collapse, the card would read zero, and because the card, the drill and the aggregate move together
-- nothing would look inconsistent enough for anyone to notice. The original values are not
-- recoverable. audit_tasks is suspended for the same window because it fires ~30 dynamic EXECUTEs per
-- row and would otherwise write an audit entry per task, in every office, for a column no person
-- edited.

-- Existing tenants: add the column in every office_* schema. The classification backfill that
-- follows it is a runner step, not part of this file — see the invariant above.
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
        ALTER TABLE %1$I.tasks
          ADD COLUMN IF NOT EXISTS source varchar(20) NOT NULL DEFAULT 'automated';
      $sql$,
      schema_name
    );

    -- Separate statement so a re-run against a schema that already has the column does not try to add a
    -- duplicate constraint (ADD CONSTRAINT has no IF NOT EXISTS).
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = format('%I.tasks', schema_name)::regclass
        AND conname = 'tasks_source_check'
    ) THEN
      EXECUTE format(
        $sql$
          ALTER TABLE %1$I.tasks
            ADD CONSTRAINT tasks_source_check CHECK (source IN ('manual', 'automated'));
        $sql$,
        schema_name
      );
    END IF;

  END LOOP;
END $tenant$;

-- New tenants: the office provisioner clones this marked block (office_dallas -> new schema). No
-- backfill here — a freshly provisioned office has no task history to classify.
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.tasks
  ADD COLUMN IF NOT EXISTS source varchar(20) NOT NULL DEFAULT 'automated';

DO $constraint$
BEGIN
  ALTER TABLE office_dallas.tasks
    ADD CONSTRAINT tasks_source_check CHECK (source IN ('manual', 'automated'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $constraint$;

-- TENANT_SCHEMA_END

COMMENT ON COLUMN office_dallas.tasks.source IS
  'Who created this task: ''manual'' (a person, via the New Task form) or ''automated'' (rules engine, email queue, cron, reassignment, revision routing). Set explicitly at every write site; the DEFAULT exists only to cover the API-migrates-before-worker-deploys window and is dropped once all writers ship. Migration 0233.';
