-- Migration 0237: tasks_assigned_source_status_idx — the index behind the automated/manual task tabs.
--
-- NUMBERING PROVENANCE (0216's header explains why "highest number on disk" is the wrong test):
--   git fetch origin --prune
--   git log --all --diff-filter=AM --name-only --format= -- 'migrations/023*'
-- Taken across ALL remote heads at authoring time: 0232 (marketing-expense-request),
-- 0233 (this branch's column migration), 0234 (task-closed-loop), 0235 (task-assignment-modal),
-- 0236 (bid-due-wednesday-report). 0237 is the first free number.
--
-- ⚠️ THE INVARIANT, AND IT APPLIES TO EVERY FUTURE MIGRATION THAT TOUCHES THIS TABLE:
--   NOTHING THAT TAKES A LOCK ON `tasks` MAY RUN INSIDE A MIGRATION FILE'S SINGLE TRANSACTION
--   ACROSS EVERY OFFICE.
-- runner.ts sends each .sql file as ONE client.query(sql), so a DO block looping every office holds
-- every lock it takes until the LAST office finishes; per-tenant transactions are not expressible in a
-- migration file. That is why the real build happens in a runner step, and why even the nominally
-- no-op statements below are catalog-guarded — see the comment on the guard itself.
--
-- For NON-index locking work (a backfill, a DISABLE TRIGGER), use the reusable per-office step in
-- server/src/migrations/per-office-step.ts. Indexes need this file's sibling pattern instead, because
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction at all.
--
-- WHY THIS IS A SEPARATE MIGRATION FROM 0233, WHICH ADDS THE COLUMN IT INDEXES.
-- The runner builds this index CONCURRENTLY in a pre-step (server/src/migrations/task-source-index.ts)
-- so that API boot never takes a write-blocking lock on `tasks` across every office at once — the loop
-- in a migration file is ONE statement in ONE transaction, so an inline build holds its locks until the
-- LAST tenant finishes, and `tasks` is written by the rules engine, the email queue, two crons, deal
-- reassignment and every person using the New Task form.
--
-- A pre-step can only build an index on a column that already EXISTS. While the column and the index
-- lived in the same migration, on the FIRST deploy the pre-step found no `source` column, skipped every
-- schema, and the file's own plain CREATE INDEX did the blocking build instead — the exact outage the
-- pre-step exists to prevent, on the one deploy where the table is largest and unindexed. On the second
-- deploy it behaved perfectly, which is why nothing would have reported it.
--
-- Splitting them makes the ordering structural: 0233 adds the column and backfills, this file's pre-step
-- then has its precondition satisfied and does the real work CONCURRENTLY, and the plain
-- CREATE INDEX IF NOT EXISTS below no-ops on every existing tenant while remaining the marker the office
-- provisioner replays for schemas created after this deploy.

-- Existing tenants: no-ops wherever the runner's CONCURRENTLY pre-step has already built this.
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
    -- Skip a partially-provisioned office schema with no tasks table, rather than aborting this
    -- migration (and every other tenant with it) for one incomplete schema.
    IF to_regclass(format('%I.tasks', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    -- ...and skip one that never received 0233's column, for the same reason: there is nothing to index
    -- there, and raising on the undefined column would take every other office down with it. The
    -- pre-step applies the identical test, so the two halves skip and act on exactly the same schemas.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = schema_name AND table_name = 'tasks' AND column_name = 'source'
    ) THEN
      CONTINUE;
    END IF;

    -- CATALOG-GUARDED, because `CREATE INDEX IF NOT EXISTS` is NOT free on an index that already
    -- exists: Postgres opens the table with a write-conflicting SHARE lock BEFORE it evaluates
    -- IF NOT EXISTS. Inside this loop's single transaction that nominal no-op would lock every
    -- tenant's tasks until the file finished, and one office with a long-running task transaction
    -- would stall the migration there while writes queued in every office already visited. Reading
    -- pg_class takes no lock at all, so on a normal deploy — where the runner's CONCURRENTLY pre-step
    -- has already built this — the loop below touches nothing.
    IF NOT EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = schema_name
        AND c.relname = 'tasks_assigned_source_status_idx'
    ) THEN
      EXECUTE format(
        $sql$
          CREATE INDEX IF NOT EXISTS tasks_assigned_source_status_idx
            ON %1$I.tasks (assigned_to, source, status, due_date);
        $sql$,
        schema_name
      );
    END IF;
  END LOOP;
END $tenant$;

-- New tenants: the office provisioner clones this marked block (office_dallas -> new schema). A freshly
-- provisioned office has no rows, so this build is instant there.
-- TENANT_SCHEMA_START
DO $provision$
BEGIN
  -- Guarded for the same reason as the loop: this block executes as part of the migration too, against
  -- office_dallas, where the pre-step has already built the index — and a bare CREATE INDEX
  -- IF NOT EXISTS would take a SHARE lock on that office's tasks for the rest of the file. The
  -- provisioner rewrites every office_dallas occurrence (including the one below) to the new schema,
  -- where the index does not exist and the table is empty, so the build there is instant.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'office_dallas'
      AND c.relname = 'tasks_assigned_source_status_idx'
  ) THEN
    CREATE INDEX IF NOT EXISTS tasks_assigned_source_status_idx
      ON office_dallas.tasks (assigned_to, source, status, due_date);
  END IF;
END $provision$;
-- TENANT_SCHEMA_END
