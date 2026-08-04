-- Migration 0215: re-flag `office_*.portfolio_projects.is_board_relevant` for the stages that only
-- became board stages in this release.
--
-- 0214 is the highest number on disk, so this is the next free one.
--
-- WHY THIS IS A MIGRATION AND NOT A LINE IN A PR DESCRIPTION.
-- `is_board_relevant` is a CACHED CLASSIFICATION, not a fact about the project. It is written at ingest
-- time by whatever the stage classifier said THAT DAY:
--   • the seed CLI hard-codes `true` (it only ever inserted candidates that already passed the classifier);
--   • the webhook relay writes `isPortfolioProjectBoardRelevantStage(...)` on every stage change.
-- This release widened that classifier: Pre-Construction, Estimating and the whole `Service - *` track are
-- board stages now, and the predicate driving the column fails OPEN so an unrecognised stage stays relevant.
-- Rows written by the OLD classifier keep the OLD answer. Nothing recomputes them — the 4-hourly worker
-- refresh touches only total_value/value_synced_at, and the relay only rewrites the flag when a NEW stage
-- change arrives for that project, which for a project sitting in Pre-Construction may be months away.
-- Both read paths filter on it (`listPortfolioProjectBoard` and `getPortfolioProjectDetail` in
-- server/src/modules/projects/service.ts, `WHERE is_board_relevant = true`), so without this file those
-- projects stay invisible after deploy — and stay invisible until somebody remembers to run SQL by hand,
-- which is precisely the kind of remembering that does not happen.
--
-- WHAT IT DOES NOT FIX, and this is the more important half.
-- An UPDATE cannot create a row that was never inserted. The seed CLI's old classifier REJECTED every
-- project in the newly-mapped stages outright, so ~94 of the 378 active SyncHub projects — every
-- `Service - *` project, every Pre-Construction and Estimating one — have NO ROW IN THIS TABLE AT ALL.
-- This migration cannot reach them and does not pretend to. Closing that gap needs the seed CLI re-run
-- against SyncHub, which is a human action against production data:
--     node --import tsx scripts/seed-portfolio-projects-from-synchub.ts --dry-run
--     node --import tsx scripts/seed-portfolio-projects-from-synchub.ts --commit
-- (Note the seed stamps `current_stage_entered_at` with the SEED RUN TIME, not the real Procore entry
-- time, and the board orders by that column DESC — so freshly seeded projects sort to the top of their
-- columns. That is pre-existing behaviour, called out here so the run is not a surprise.)
-- In short: this migration closes the FLAG gap. It does not close the INGESTION gap.
--
-- THE EXCLUSION LIST IS DUPLICATED FROM CODE, deliberately and with a comment, because SQL cannot import
-- `PORTFOLIO_PROJECT_OFF_BOARD_STAGES` (shared/src/types/portfolio-project-stages.ts). The two must agree:
-- a runtime test (server/tests/migrations/0215-...) reads THIS FILE and asserts the literals here are
-- exactly that constant, so the pair cannot drift silently.
--
-- MATCHED ON `current_stage`, NOT `current_stage_normalized`. The normalized column holds whatever the
-- normalizer produced when the row was written, and this release changed one of those outputs
-- ("pre - construction" -> "pre-construction"), so the stored value is not reliably today's canonical form.
-- The RAW Procore string is what it has always been. `lower(btrim(...))` matches the normalizer's own first
-- two steps, which is all these two exclusion literals need (neither contains an underscore, a hyphen, or a
-- run of internal whitespace). Board placement itself needs no data fix: the board re-normalizes at READ
-- time, so a stale `current_stage_normalized` lands in the right column on its own.
--
-- IDEMPOTENT: the `is_board_relevant = false` predicate means a replay updates zero rows. Re-running this
-- migration is a no-op, which the runner relies on.
--
-- NOT A BLANKET `SET is_board_relevant = true`: the two legacy buckets are ~183 of the 378 active projects
-- and are excluded BY DECISION. Flipping them would put every dead Hold/Lost project on the board.

DO $tenant$
DECLARE
  schema_name text;
  flipped bigint;
BEGIN
  FOR schema_name IN
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\_%' ESCAPE '\' ORDER BY nspname
  LOOP
    -- Half-provisioned schemas are skipped rather than assumed. `portfolio_projects` arrives in 0135, so
    -- on a real migration run it is always there; this keeps a partially-built tenant from being the thing
    -- that decides whether 0215 can run at all for every OTHER office in the same DO block.
    IF to_regclass(format('%I.portfolio_projects', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'UPDATE %I.portfolio_projects
          SET is_board_relevant = true,
              updated_at = NOW()
        WHERE is_board_relevant = false
          AND lower(btrim(current_stage)) NOT IN (%L, %L)',
      schema_name, 'hold (legacy)', 'lost/cancelled (legacy)'
    );
    GET DIAGNOSTICS flipped = ROW_COUNT;

    -- Per-office count in the deploy log, so the operator can tell "nothing needed flipping" apart from
    -- "the loop never reached this office" — the two look identical in a silent migration.
    RAISE NOTICE '0215: % — % portfolio project(s) flipped to board-relevant', schema_name, flipped;
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner, which lifts the block between these markers and rewrites
-- `office_dallas` to the new schema name (server/src/modules/office/service.ts).
--
-- This one is a BACKFILL, so unlike a table-creating migration the block is a genuine no-op for a freshly
-- provisioned schema: a brand-new office has no portfolio_projects rows to re-flag, and every row it goes
-- on to receive is written by the NEW classifier already. It is kept anyway so this file has the same
-- shape as every other tenant migration — the failure mode the markers exist to prevent is somebody
-- adding a statement to the DO-loop later and not here, and a file with no block at all is where that
-- omission is easiest to miss.
-- TENANT_SCHEMA_START
UPDATE office_dallas.portfolio_projects
   SET is_board_relevant = true,
       updated_at = NOW()
 WHERE is_board_relevant = false
   AND lower(btrim(current_stage)) NOT IN ('hold (legacy)', 'lost/cancelled (legacy)');
-- TENANT_SCHEMA_END
