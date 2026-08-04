-- Migration 0216: re-flag `office_*.portfolio_projects.is_board_relevant` for the stages that only
-- became board stages in this release.
--
-- NUMBERING PROVENANCE, recorded because "the highest number on disk" is the WRONG TEST and this file
-- learned that the expensive way.
--   • Authored on `feat/portfolio-production-rollup` (PR #1040), branched from `main`.
--   • Highest migration on `main` at the time: 0214 (0214_glasses_walkthroughs.sql).
--   • Originally numbered 0215 on that basis — and 0215 was ALREADY TAKEN, by
--     `0215_backfill_needs_quantity.sql` on `fix/null-quantity-not-one` (PR #1029, open, unmerged).
--     Invisible from this worktree: neither file is on `main`, so nothing local could have shown it.
--   • Renumbered to 0216 (#1029 claimed 0215 first). 0216 verified free across ALL 947 remote heads, not
--     just `main`, with:
--         git fetch origin --prune
--         git log --all --diff-filter=AM --name-only --format= -- 'migrations/021*' 'migrations/022*'
-- The API auto-runs migrations on deploy (server startup), so a duplicate number is not a merge-time
-- annoyance — it is a production-deploy problem. If you are adding a migration from a branch, run the
-- --all search above rather than trusting `ls migrations/`.
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
-- MATCHED ON `current_stage`, NOT `current_stage_normalized`. The normalized column holds whatever the
-- normalizer produced when the row was written, and this release changed one of those outputs
-- ("pre - construction" -> "pre-construction"), so the stored value is not reliably today's canonical form.
-- The RAW Procore string is what it has always been. Board PLACEMENT needs no data fix either way: the
-- board re-normalizes at READ time, so a stale `current_stage_normalized` lands in the right column anyway.
--
-- ...WHICH IS WHY THE EXCLUSION HAS TO NORMALIZE, and an earlier draft of this file got that wrong.
-- Matching raw text against the two CANONICAL strings 'hold (legacy)' / 'lost/cancelled (legacy)' missed
-- every other spelling that the TypeScript classifier maps into those buckets — `Hold`, `Lost/Cancelled`,
-- `Lost / Cancelled (Legacy)`, and any underscore or spacing variant. Those rows would have been flipped
-- ONTO the board: genuinely dead work, visible until some later stage event happened to rewrite the flag.
-- Choosing the raw column is what created that obligation, so the fix is to apply the SAME normalization
-- here that `normalizePortfolioProjectStage` applies in TypeScript, rather than to enumerate spellings —
-- enumerating spellings is precisely what went wrong.
--
-- `pg_temp.portfolio_stage_is_off_board` below mirrors that function step for step. A MIRROR IS ONLY WORTH
-- ANYTHING IF IT IS EXACT, and an earlier draft of it was not: it used `btrim`, whose one-argument form
-- strips SPACES ONLY. JS `.trim()` strips all whitespace, so a stage stored as E'\tHold\t' survived the
-- trim, became " hold " after the collapse, matched no alias key, and got flipped onto the board — the
-- very bug this exclusion exists to prevent, reintroduced through a whitespace variant.
--
-- Derivation, operation by operation. "identical" means the two primitives agree on the FULL input domain;
-- anything less is spelled out.
--   1. String(stage ?? "")          <-> coalesce(raw_stage, '')          identical.
--   2. .trim()                      <-> regexp_replace ^[ws]+ / [ws]+$   identical ONLY with the `ws` class
--      below. NOT btrim(): btrim(text) is btrim(text, ' ') and leaves tabs, newlines and NBSP in place.
--      Trimming happens FIRST, exactly as in JS, and there is deliberately NO trailing trim — JS trims
--      before collapsing, so `_Hold` normalizes to " hold" WITH a leading space (the underscore becomes
--      one) and is therefore NOT off-board. A tidy final trim would make SQL say "hold" and disagree.
--   3. .toLowerCase()               <-> lower()                          similar, not identical: lower() is
--      collation-dependent while JS is full Unicode. Bounded and harmless here — every off-board alias key
--      is ASCII, and no non-ASCII character lowercases INTO one of them — but it is a real difference, so
--      the parity test drives non-ASCII input rather than assuming.
--   4. /[_\s]+/g -> " "             <-> '[_' || ws || ']+'               identical with `ws`; NOT with bare
--      POSIX [[:space:]], which matches only the ASCII six and lets U+00A0 and the U+2000 block through.
--   5. /\s*-\s*/g -> " - "          <-> '[ws]*-[ws]*'                    identical, greediness included:
--      both engines leave "a--b" as "a -  - b" (verified, not assumed).
--   6. /\s+/g -> " "                <-> '[' || ws || ']+'                identical with `ws`.
-- `ws` is JS's \s spelled out: POSIX [[:space:]] for the ASCII six, plus U+00A0, U+1680, U+2000-U+200A,
-- U+2028, U+2029, U+202F, U+205F, U+3000 and U+FEFF.
--
-- One divergence remains BY CONSTRUCTION: the `??` precedence of the three alias lookups. A string whose
-- bare form hit a BOARD alias while a hyphen variant hit an OFF-BOARD one would classify differently. No
-- such string exists — not one off-board alias key contains a hyphen, so the variants can only ever match
-- the same bucket the bare form does. This is argued, not tested, and is the only claim here that is.
--
-- THE ALIAS LIST IS STILL DUPLICATED FROM CODE, because SQL cannot import the module. It is pinned:
-- a runtime test (server/tests/migrations/0216-...) reads THIS FILE and asserts the literals in EVERY copy
-- of the function equal `PORTFOLIO_OFF_BOARD_STAGE_ALIASES` — the alias KEYS derived from the map itself,
-- not the two canonical values. That is the test that would have caught the bug above; the previous one
-- compared against the canonical list and passed happily while the migration was wrong.
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
  -- `normalizePortfolioProjectStage` + `isPortfolioProjectOffBoardStage`, in SQL. `pg_temp` so it is
  -- session-local and disappears on its own — a migration has no business leaving a helper behind in a
  -- schema the application reads (same reasoning as 0214's timestamp helper).
  --
  -- POSIX classes rather than `\s`: `[[:space:]]` is the portable spelling in regexp_replace. The three
  -- substitutions are the TypeScript ones in the same order — collapse underscores/whitespace, pad hyphens
  -- to " - ", collapse whitespace again — and the padding survives the final collapse because it is
  -- already single-spaced.
  EXECUTE $fn$
    CREATE OR REPLACE FUNCTION pg_temp.portfolio_stage_is_off_board(raw_stage text)
    RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $body$
    DECLARE
      off_board constant text[] := ARRAY[
        'hold',
        'hold (legacy)',
        'lost / cancelled (legacy)',
        'lost/cancelled',
        'lost/cancelled (legacy)'
      ];
      ws constant text := '[:space:]\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
      bare text;
      hyphen_as_space text;
      compact_hyphen text;
    BEGIN
      bare := regexp_replace(coalesce(raw_stage, ''), '^[' || ws || ']+', '');
      bare := regexp_replace(bare, '[' || ws || ']+$', '');
      bare := lower(bare);
      bare := regexp_replace(bare, '[_' || ws || ']+', ' ', 'g');
      bare := regexp_replace(bare, '[' || ws || ']*-[' || ws || ']*', ' - ', 'g');
      bare := regexp_replace(bare, '[' || ws || ']+', ' ', 'g');
      hyphen_as_space := regexp_replace(bare, '[' || ws || ']*-[' || ws || ']*', ' ', 'g');
      hyphen_as_space := regexp_replace(hyphen_as_space, '[' || ws || ']+', ' ', 'g');
      compact_hyphen := regexp_replace(bare, '[' || ws || ']*-[' || ws || ']*', '-', 'g');
      RETURN bare = ANY(off_board)
          OR hyphen_as_space = ANY(off_board)
          OR compact_hyphen = ANY(off_board);
    END;
    $body$
  $fn$;

  FOR schema_name IN
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\_%' ESCAPE '\' ORDER BY nspname
  LOOP
    -- Half-provisioned schemas are skipped rather than assumed. `portfolio_projects` arrives in 0135, so
    -- on a real migration run it is always there; this keeps a partially-built tenant from being the thing
    -- that decides whether 0216 can run at all for every OTHER office in the same DO block.
    IF to_regclass(format('%I.portfolio_projects', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'UPDATE %I.portfolio_projects
          SET is_board_relevant = true,
              updated_at = NOW()
        WHERE is_board_relevant = false
          AND NOT pg_temp.portfolio_stage_is_off_board(current_stage)',
      schema_name
    );
    GET DIAGNOSTICS flipped = ROW_COUNT;

    -- Per-office count in the deploy log, so the operator can tell "nothing needed flipping" apart from
    -- "the loop never reached this office" — the two look identical in a silent migration.
    RAISE NOTICE '0216: % — % portfolio project(s) flipped to board-relevant', schema_name, flipped;
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
--
-- It re-creates the pg_temp helper because the provisioner runs this block STANDALONE, outside the DO
-- block above, so the session it runs in has no such function. The alias array is therefore duplicated —
-- the drift test asserts EVERY copy in this file carries the same list, so the two cannot diverge.
-- TENANT_SCHEMA_START
CREATE OR REPLACE FUNCTION pg_temp.portfolio_stage_is_off_board(raw_stage text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $body$
DECLARE
  off_board constant text[] := ARRAY[
    'hold',
    'hold (legacy)',
    'lost / cancelled (legacy)',
    'lost/cancelled',
    'lost/cancelled (legacy)'
  ];
  ws constant text := '[:space:]\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
  bare text;
  hyphen_as_space text;
  compact_hyphen text;
BEGIN
  bare := regexp_replace(coalesce(raw_stage, ''), '^[' || ws || ']+', '');
  bare := regexp_replace(bare, '[' || ws || ']+$', '');
  bare := lower(bare);
  bare := regexp_replace(bare, '[_' || ws || ']+', ' ', 'g');
  bare := regexp_replace(bare, '[' || ws || ']*-[' || ws || ']*', ' - ', 'g');
  bare := regexp_replace(bare, '[' || ws || ']+', ' ', 'g');
  hyphen_as_space := regexp_replace(bare, '[' || ws || ']*-[' || ws || ']*', ' ', 'g');
  hyphen_as_space := regexp_replace(hyphen_as_space, '[' || ws || ']+', ' ', 'g');
  compact_hyphen := regexp_replace(bare, '[' || ws || ']*-[' || ws || ']*', '-', 'g');
  RETURN bare = ANY(off_board)
      OR hyphen_as_space = ANY(off_board)
      OR compact_hyphen = ANY(off_board);
END;
$body$;

UPDATE office_dallas.portfolio_projects
   SET is_board_relevant = true,
       updated_at = NOW()
 WHERE is_board_relevant = false
   AND NOT pg_temp.portfolio_stage_is_off_board(current_stage);
-- TENANT_SCHEMA_END
