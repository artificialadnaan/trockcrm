-- Migration 0233: `tasks.source` — did a PERSON create this task, or did the system?
--
-- NUMBERING PROVENANCE (0216's header explains why "highest number on disk" is the wrong test):
--   git fetch origin --prune
--   git log --all --diff-filter=AM --name-only --format= -- 'migrations/022*' 'migrations/023*'
-- Highest across ALL remote heads at authoring time: 0231 (0231_weekly_report_views.sql). 0232 is taken
-- by an in-flight branch that has not merged yet, so 0233 is the first free number.
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
-- So the answer has to be recorded at write time. This migration adds the column and classifies the
-- history; the write sites that set it explicitly land next.
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
-- ⚠️ THE TRIGGERS ARE DISABLED AROUND THE BACKFILL, AND THAT IS THE MOST IMPORTANT LINE IN THIS FILE.
-- `tasks` carries set_tasks_updated_at (0001:858 -> set_updated_at at 0001:368), which sets
-- NEW.updated_at = NOW() on every UPDATE, unconditionally. The contacts list reads MAX(tasks.updated_at)
-- straight through as a contact's "Last touch" (contacts/service.ts buildContactLastTouchAtSql), and the
-- "Untouched 30d+" card, its ?card=untouched drill and the aggregate count are ALL derived from that one
-- expression. Letting the trigger fire here would stamp every contact that has ever had a task with this
-- migration's timestamp: the sort would collapse, the card would read zero, and because the card, the
-- drill and the aggregate move together nothing would look inconsistent enough for anyone to notice.
-- The original values are not recoverable. audit_tasks is disabled for the same window because it fires
-- ~30 dynamic EXECUTEs per row and would otherwise write an audit entry per task, in every office, for a
-- column no person edited.
--
-- Both UPDATEs are also guarded on the value actually changing, so a row that is already classified
-- correctly is never rewritten at all.
--
-- NO INLINE INDEX BUILD ON THE HOT PATH — see server/src/migrations/task-source-index.ts. The runner
-- builds tasks_assigned_source_status_idx CONCURRENTLY per office BEFORE executing this file; the plain
-- CREATE INDEX IF NOT EXISTS below then no-ops on existing tenants while remaining the marker the office
-- provisioner replays for schemas created after this deploy.

-- Existing tenants: add the column, classify the history, build the index in every office_* schema.
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

    -- See the header: this wrapper is what keeps the contacts "Last touch" column and the "Untouched
    -- 30d+" card intact.
    --
    -- UNCONDITIONAL ON PURPOSE — not wrapped in an "if the trigger exists" test. If a tenant schema
    -- somehow lacks these triggers, the right outcome is this migration aborting loudly on deploy, which
    -- is visible and fully recoverable (nothing has been written yet). The alternative — skip the
    -- disable, carry on, and backfill with set_tasks_updated_at live — is the irreversible one. Given the
    -- choice between failing loudly and corrupting a metric silently, fail loudly.
    EXECUTE format('ALTER TABLE %1$I.tasks DISABLE TRIGGER set_tasks_updated_at', schema_name);
    EXECUTE format('ALTER TABLE %1$I.tasks DISABLE TRIGGER audit_tasks', schema_name);

    EXECUTE format(
      $sql$
        -- A task with no originating rule but a person recorded against it is a person's task. This is
        -- the only statement that reclassifies at scale; every automated shape in production carries a
        -- non-null origin_rule (rules engine, email queue, AI-disconnect cron, revision routing), so
        -- they are all excluded here and keep the 'automated' default without being rewritten.
        UPDATE %1$I.tasks SET source = 'manual'
         WHERE origin_rule IS NULL
           AND created_by IS NOT NULL
           AND source = 'automated'
           -- ...except reassignment tasks (assignment-tasks/service.ts), which this would otherwise
           -- sweep up: they record the person who reassigned the deal, so they look hand-typed on every
           -- column. They are machine-written and are exactly the volume people are complaining about.
           -- Excluded HERE rather than corrected in a second pass so the backfill converges in one go —
           -- setting them to 'manual' and then putting them back would rewrite every reassignment row
           -- twice to arrive where it started, which is the row-churn the whole file is careful to
           -- avoid. Two markers identify them TOGETHER: the fixed title AND the assignedAt key the
           -- snapshot always carries. The title alone would misfile a person's task worded the same way,
           -- and COALESCE keeps a NULL snapshot (never written by that path) on the human side.
           AND NOT (
             title IN ('New Deal Assignment', 'New Lead Assignment')
             AND COALESCE(entity_snapshot ? 'assignedAt', false)
           );

        -- Repairs a reassignment task some earlier run left on 'manual' — a partially-applied backfill,
        -- or a hand replay against a restored dump taken mid-flight. A converged schema matches nothing
        -- here, which is the point: it is a repair, not part of the classification.
        UPDATE %1$I.tasks SET source = 'automated'
         WHERE origin_rule IS NULL
           AND title IN ('New Deal Assignment', 'New Lead Assignment')
           AND entity_snapshot ? 'assignedAt'
           AND source <> 'automated';
      $sql$,
      schema_name
    );

    EXECUTE format('ALTER TABLE %1$I.tasks ENABLE TRIGGER audit_tasks', schema_name);
    EXECUTE format('ALTER TABLE %1$I.tasks ENABLE TRIGGER set_tasks_updated_at', schema_name);

    -- No-ops on every tenant the runner's CONCURRENTLY pre-step already built this for; the real work
    -- happens there. Present so a schema created after this deploy still gets the index.
    EXECUTE format(
      $sql$
        CREATE INDEX IF NOT EXISTS tasks_assigned_source_status_idx
          ON %1$I.tasks (assigned_to, source, status, due_date);
      $sql$,
      schema_name
    );
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

CREATE INDEX IF NOT EXISTS tasks_assigned_source_status_idx
  ON office_dallas.tasks (assigned_to, source, status, due_date);
-- TENANT_SCHEMA_END

COMMENT ON COLUMN office_dallas.tasks.source IS
  'Who created this task: ''manual'' (a person, via the New Task form) or ''automated'' (rules engine, email queue, cron, reassignment, revision routing). Set explicitly at every write site; the DEFAULT exists only to cover the API-migrates-before-worker-deploys window and is dropped once all writers ship. Migration 0233.';
