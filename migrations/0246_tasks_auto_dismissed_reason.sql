-- Migration 0246: `tasks.auto_dismissed_reason` — WHY was this task closed, and was a person involved?
--
-- NUMBERING PROVENANCE (0216's header explains why "highest number on disk" is the wrong test):
--   git fetch origin --prune
--   git log --all --diff-filter=AM --name-only --format= -- 'migrations/024*'
-- Across all remote heads at authoring time: 0240, 0241, 0242, 0243, 0244, 0245. 0246 is the first free
-- number.
--
-- WHY. `getFollowUpCompliance` scores `status IN ('completed','dismissed')` as the DENOMINATOR and only
-- 'completed' as the numerator, so every dismissal reads as a rep's missed follow-up — over a window that
-- defaults to the whole calendar year. But two paths dismiss tasks with no person involved at all:
-- `stage-change.ts` sweeps a deal's open tasks when it reaches a terminal stage, and the terminal-deal
-- drain retires forward-motion tasks minted onto deals that were already closed. Scoring those against the
-- rep is wrong, and the drain makes it acute: ~533 follow-ups at once, retroactively.
--
-- WHY A COLUMN AND NOT A DERIVED TEST. Two derivations were tried on this branch and both were shown to be
-- wrong, each by review:
--
--   1. `task_resolution_state.resolution_reason`. That table is keyed (origin_rule, dedupe_key), and
--      worker/src/jobs/task-completed.ts upserts it with `task_id = EXCLUDED.task_id,
--      resolution_reason = EXCLUDED.resolution_reason`. A reopened deal minting a same-key task and
--      completing it REPLACES the pointer, and the original dismissal's reason is gone.
--   2. The deal's CURRENT stage. Also mutable, and wrong in both directions: a rep who dismisses a
--      follow-up on a live deal has that genuine miss erased the moment the deal later closes, and a task
--      this drain retired re-enters the denominator as a miss if the deal is reopened — which is a
--      supported flow (deals/return-to-opportunity-service.ts).
--
-- The fact being recorded is a property OF THE DISMISSAL, at the moment it happens: who or what closed
-- this task, and why. Nothing that happens to the deal afterwards can change it. That is a column.
--
-- NULL means "a person closed this, or it is still open" — the conservative reading, and what every
-- existing row means. No backfill: historical auto-dismissals are indistinguishable from human ones from
-- here, and guessing would silently rewrite past compliance in the other direction. The column only
-- affects tasks closed from this deploy onward.
--
-- LOCKING. Per 0237's invariant, nothing that takes a lock on `tasks` may run inside this file's single
-- transaction across every office. A nullable ADD COLUMN with NO DEFAULT is metadata-only in PG11+ — it
-- rewrites nothing and returns immediately — so the ACCESS EXCLUSIVE lock is taken and released within
-- the statement rather than held for a build. The catalog guard below means a re-run touches nothing at
-- all, so the lock is not even acquired on a deploy where the column already exists.

-- Existing tenants.
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
    -- Skip a partially-provisioned office schema with no tasks table rather than aborting this migration
    -- (and every other tenant with it) for one incomplete schema. office_pwauditoffice on production is
    -- exactly this case.
    IF to_regclass(format('%I.tasks', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    -- Catalog-guarded so a re-run takes no lock at all: reading information_schema locks nothing, whereas
    -- ALTER TABLE ... ADD COLUMN IF NOT EXISTS still opens the table to evaluate its own guard.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = schema_name
         AND table_name = 'tasks'
         AND column_name = 'auto_dismissed_reason'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I.tasks ADD COLUMN auto_dismissed_reason varchar(120)',
        schema_name
      );
    END IF;
  END LOOP;
END $tenant$;

-- New tenants: the office provisioner clones this marked block (office_dallas -> new schema).
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.tasks
  ADD COLUMN IF NOT EXISTS auto_dismissed_reason varchar(120);
-- TENANT_SCHEMA_END
