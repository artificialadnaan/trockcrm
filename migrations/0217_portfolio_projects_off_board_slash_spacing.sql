-- Migration 0217: put SLASH-SPACED legacy projects back OFF the Procore board.
--
-- WHAT WENT WRONG. `normalizePortfolioProjectStage` (shared/src/types/portfolio-project-stages.ts) looked
-- an alias up under three forms — the bare normalized text, a hyphen-as-space variant, and a compact-hyphen
-- variant. Hyphen spacing was absorbed; SLASH spacing was not. Measured on the code 0216 shipped with:
--
--     "Lost / Cancelled"          bare="lost / cancelled"          norm="lost / cancelled"          RELEVANT
--     "Lost  /  Cancelled"        bare="lost / cancelled"          norm="lost / cancelled"          RELEVANT
--     "Lost/Cancelled"            bare="lost/cancelled"            norm="lost/cancelled (legacy)"   off-board
--     "Lost / Cancelled (Legacy)" bare="lost / cancelled (legacy)" norm="lost/cancelled (legacy)"   off-board
--
-- `isPortfolioProjectBoardRelevantStage` fails OPEN by design (unrecognised => relevant, so a stage nobody
-- anticipated is surfaced rather than deleted). A spaced "Lost / Cancelled" was therefore not "unmapped and
-- excluded" but "unmapped and INCLUDED": ingested by the seed, written is_board_relevant = true by the
-- relay, and rendered in the board's "Other / No Column" — dead work presented as live work.
--
-- 0216 INHERITED THE SAME BLIND SPOT AND ACTED ON IT. Its `pg_temp.portfolio_stage_is_off_board` is a
-- faithful mirror of the classifier as it stood, three lookups and no slash variant. Its UPDATE reads
--     WHERE is_board_relevant = false AND NOT pg_temp.portfolio_stage_is_off_board(current_stage)
-- so a row parked at "Lost / Cancelled" was, by that predicate, NOT off-board and got flipped TO true.
-- 0216 did not merely fail to fix these rows; where it ran, it is what put them on the board.
--
-- WHY A NEW FILE RATHER THAN A FIX TO 0216. The runner records applied migrations BY FILENAME, so an edit
-- to 0216 would never re-execute on any database that has already run it — the correction would exist in
-- git and nowhere else. 0216 is immutable in the only sense that matters. Its mirror is now knowingly one
-- lookup behind the TypeScript; that is recorded here rather than patched there, and its drift test still
-- passes because the alias MAP was not touched (see below).
--
-- WHY THE CODE FIX IS NOT A NEW ALIAS KEY. Adding 'lost / cancelled' to STAGE_ALIASES would have been the
-- one-line fix and it was rejected: `PORTFOLIO_OFF_BOARD_STAGE_ALIASES` is DERIVED from that map, and
-- server/tests/migrations/0216-*.runtime.test.ts pins 0216's embedded literal list against it. A new key
-- would fail that test against a file that can no longer be changed. The fix is instead a fourth lookup
-- form, `compactSlash` (/\s*\/\s*/g -> "/"), symmetric with `compactHyphen`. It closes the whole class —
-- any slash spacing, doubled spaces included — and adds no alias key, so the derived constant, and the
-- drift test, are untouched.
--
-- DIRECTION: THIS MIGRATION ONLY EVER FLIPS true -> false, and that is a property of the code change, not
-- a choice of scope. A lookup variant can only widen a match toward an alias key that ALREADY EXISTS; it
-- cannot mint a stage. No board alias key contains a slash, so `compactSlash` can resolve to exactly two
-- keys, 'lost/cancelled' and 'lost/cancelled (legacy)', both off-board. There is consequently no input
-- whose verdict moved off-board -> board-relevant, hence no false -> true correction to make, and the
-- widening 0216 performed does not need re-running.
--
-- SCOPE: EVERY row whose stage the CURRENT classifier calls off-board while the flag still says relevant —
-- not just the arithmetic difference between the two predicates. The column is a cached classification with
-- no human writer, so `is_board_relevant = isPortfolioProjectBoardRelevantStage(current_stage)` is simply
-- an invariant, and restoring it is both easier to argue and easier to re-run than reconstructing which
-- rows 0216 personally touched (which the table does not record). In practice the two sets coincide: the
-- spellings the old predicate already caught were left false by 0216 and match nothing here.
--
-- MATCHED ON `current_stage`, the RAW Procore text, for 0216's reason: `current_stage_normalized` holds
-- whatever the normalizer emitted the day the row was written and is not reliably today's canonical form.
-- That column is deliberately NOT rewritten here — the board re-normalizes it at read time
-- (`toPortfolioProjectSummary`), so a stale value costs nothing and rewriting it would churn rows.
--
-- IDEMPOTENT, and independent of whether 0216 has run. A replay matches zero rows because the first pass
-- already set the flag false, so `updated_at` is not churned. On a fresh database the runner applies 0216
-- then 0217 in filename order — 0216 widens, 0217 corrects, and the end state is the same one an
-- already-migrated database reaches. On a database where 0216 ran weeks ago, this runs alone and reaches
-- that same state.
--
-- THE SQL MIRROR IS 0216'S, PLUS THE FOURTH FORM. Everything 0216's header argues about that mirror still
-- applies verbatim and is not repeated here: the explicit `ws` code-point list instead of POSIX
-- `[[:space:]]` (PostgreSQL evaluates POSIX classes per the ACTIVE COLLATION while JS \s is a fixed set,
-- so a parity test run against one backend cannot see that class of divergence at all); the leading/
-- trailing regexp_replace instead of `btrim`, which strips spaces ONLY and once let E'\tHold\t' onto the
-- board; trimming BEFORE collapsing, so `_Hold` stays " hold" and is correctly not off-board. The one
-- addition is `compact_slash`, mirroring `normalized.replace(/\s*\/\s*/g, "/")` — `[ws]*/[ws]*` -> '/',
-- with the same `ws` class, applied to the same `bare` value as the other two variants.
--
-- The alias literals are duplicated from TypeScript because SQL cannot import the module, and are pinned
-- the same way 0216's are: server/tests/migrations/0217-*.runtime.test.ts asserts the literals in EVERY
-- copy of the helper in THIS file equal `PORTFOLIO_OFF_BOARD_STAGE_ALIASES`, and drives both classifiers
-- over the slash spellings and the adversarial whitespace set to require agreement.

DO $tenant$
DECLARE
  schema_name text;
  flipped bigint;
BEGIN
  -- `normalizePortfolioProjectStage` + `isPortfolioProjectOffBoardStage`, in SQL, WITH the slash variant.
  -- `pg_temp` so it is session-local and disappears on its own; a distinct name from 0216's helper so that
  -- running both files in one session cannot leave either one executing the other's predicate.
  EXECUTE $fn$
    CREATE OR REPLACE FUNCTION pg_temp.portfolio_stage_is_off_board_slash_aware(raw_stage text)
    RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $body$
    DECLARE
      off_board constant text[] := ARRAY[
        'hold',
        'hold (legacy)',
        'lost / cancelled (legacy)',
        'lost/cancelled',
        'lost/cancelled (legacy)'
      ];
      ws constant text := '\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
      bare text;
      hyphen_as_space text;
      compact_hyphen text;
      compact_slash text;
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
      compact_slash := regexp_replace(bare, '[' || ws || ']*/[' || ws || ']*', '/', 'g');
      RETURN bare = ANY(off_board)
          OR hyphen_as_space = ANY(off_board)
          OR compact_hyphen = ANY(off_board)
          OR compact_slash = ANY(off_board);
    END;
    $body$
  $fn$;

  FOR schema_name IN
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\_%' ESCAPE '\' ORDER BY nspname
  LOOP
    -- A half-provisioned schema is skipped rather than assumed, so it cannot decide whether 0217 runs for
    -- every OTHER office in the same DO block. Same guard, same reason, as 0216.
    IF to_regclass(format('%I.portfolio_projects', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'UPDATE %I.portfolio_projects
          SET is_board_relevant = false,
              updated_at = NOW()
        WHERE is_board_relevant = true
          AND pg_temp.portfolio_stage_is_off_board_slash_aware(current_stage)',
      schema_name
    );
    GET DIAGNOSTICS flipped = ROW_COUNT;

    -- Per-office count in the deploy log, so "nothing needed correcting" is distinguishable from "the loop
    -- never reached this office" — the two are identical in a silent migration.
    RAISE NOTICE '0217: % — % portfolio project(s) flipped OFF the board', schema_name, flipped;
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner, which lifts the block between these markers and rewrites
-- `office_dallas` to the new schema name (server/src/modules/office/service.ts).
--
-- Like 0216 this is a BACKFILL, so for a freshly provisioned schema the block is a genuine no-op: a new
-- office has no portfolio_projects rows, and every row it goes on to receive is classified by the fixed
-- normalizer. It is kept so this file has the same shape as every other tenant migration — the omission
-- the markers exist to prevent is somebody extending the DO-loop later and not this block, and a file with
-- no block at all is where that is easiest to miss.
--
-- It re-creates the pg_temp helper because the provisioner runs this block STANDALONE, outside the DO
-- block above, in a session that has no such function. The alias array is therefore duplicated — the drift
-- test asserts every copy in this file carries the same list, so the two cannot diverge.
-- TENANT_SCHEMA_START
CREATE OR REPLACE FUNCTION pg_temp.portfolio_stage_is_off_board_slash_aware(raw_stage text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $body$
DECLARE
  off_board constant text[] := ARRAY[
    'hold',
    'hold (legacy)',
    'lost / cancelled (legacy)',
    'lost/cancelled',
    'lost/cancelled (legacy)'
  ];
  ws constant text := '\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
  bare text;
  hyphen_as_space text;
  compact_hyphen text;
  compact_slash text;
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
  compact_slash := regexp_replace(bare, '[' || ws || ']*/[' || ws || ']*', '/', 'g');
  RETURN bare = ANY(off_board)
      OR hyphen_as_space = ANY(off_board)
      OR compact_hyphen = ANY(off_board)
      OR compact_slash = ANY(off_board);
END;
$body$;

UPDATE office_dallas.portfolio_projects
   SET is_board_relevant = false,
       updated_at = NOW()
 WHERE is_board_relevant = true
   AND pg_temp.portfolio_stage_is_off_board_slash_aware(current_stage);
-- TENANT_SCHEMA_END
