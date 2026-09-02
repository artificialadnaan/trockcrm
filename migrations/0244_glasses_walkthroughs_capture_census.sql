-- Migration 0244: `glasses_walkthroughs.capture_census` — what the phone's recorder ACTUALLY wrote.
--
-- NUMBERING PROVENANCE (0216's header explains why "highest number on disk" is the wrong test):
--   git fetch origin --prune
--   git log --all --diff-filter=AM --name-only --format= -- 'migrations/024*' 'migrations/025*'
-- Across all remote heads at authoring time: 0240, 0241, 0242 (all on origin/main) and 0243
-- (`glasses_walkthrough_job_type`, on feat/glasses-walk-job-type and NOT on origin/main — exactly the case
-- the provenance rule exists for). 0243 touches this same table; both files are a single
-- `ADD COLUMN IF NOT EXISTS` on independent columns, so either may land first and each replays cleanly
-- after the other. 0244 is the first free number.
--
-- WHY. A glasses walk is recorded on the phone, and the phone COUNTS what its recorder writes as it goes:
-- frames received, appended and dropped; audio buffers likewise; seconds of narration that landed; how
-- many times the audio engine had to be restarted. It uses that census for the completion screen and the
-- "(audio cut short)" marker in the walk's title — and then discards it. On 2026-09-02 two walks lost
-- 3.8 min and 30 s of narration, and diagnosing them meant pulling 400 MB of video out of object storage
-- and reading packet timestamps, because nothing server-side recorded what the phone already knew. The
-- mobile app now sends the census on the completion call; this column is where it lands, beside the walk
-- it describes, so the same question is one row read.
--
-- JSONB, NOT COLUMNS, and that is a decision about who owns the shape. The census is the RECORDER's own
-- diagnostic, on the phone's release cadence: it will grow a counter the day someone needs one, and a
-- column per counter would put a mobile change behind a migration every time. Nothing filters on it, nothing
-- indexes it, nothing joins through it — it is read by the deal page's AI-walk panel and by whoever is
-- diagnosing a bad walk, and written once. The contract is typed and validated in code
-- (shared/src/types/glasses-walk-capture-census.ts, applied at the ingest route), where unknown keys are
-- kept and the whole document is bounded to 64 KiB with the event log capped at 200 entries. The one
-- number the office needs — how much of the walk has no narration behind it — is DERIVED at read time from
-- three of these counters and never stored, so it cannot disagree with the counts it came from.
--
-- NULLABLE, AND NULL IS A REAL ANSWER: "this client did not send one". Every walk filed before the mobile
-- change, and every walk from an older app build after it, is exactly that, and the ingest route stores it
-- as such rather than inventing zeros a reader would take for a walk that recorded nothing.
--
-- NO BACKFILL, AND NONE IS POSSIBLE. The census exists only on the phone while it is recording; the
-- forward-job payloads 0214 backfilled from never carried it. The walks this feature was written for are
-- the first ones it cannot help.
--
-- FIRST NON-NULL WINS on a re-filed walk. A completion is retried as a matter of course (0214's index
-- explains why), and a retry — plausibly from a different session on a recovered walk — has no better
-- census than the completion that was actually there. `recordGlassesWalkthrough` fills this column only
-- when it is NULL, in the same `ON CONFLICT` statement that keeps the row's other facts from the first
-- completion.

DO $tenant$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\_%' ESCAPE '\' ORDER BY nspname
  LOOP
    -- An office provisioned before 0214 has no glasses table at all. Skipping is correct rather than
    -- defensive: the provisioner's own tenant template below carries the column, so such an office gets
    -- it whenever the table itself arrives.
    IF to_regclass(format('%I.glasses_walkthroughs', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE %I.glasses_walkthroughs ADD COLUMN IF NOT EXISTS capture_census jsonb',
      schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner, which lifts the block between these markers and rewrites
-- `office_dallas` to the new schema name (server/src/modules/office/service.ts). It must stay in PARITY
-- with the DO-loop above — a column added only in the loop exists for today's offices and silently does
-- not exist for the next one provisioned, which is a 42703 on an ingest nobody can reproduce.
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.glasses_walkthroughs
  ADD COLUMN IF NOT EXISTS capture_census jsonb;
-- TENANT_SCHEMA_END

COMMENT ON COLUMN office_dallas.glasses_walkthroughs.capture_census IS
  'What the phone''s recorder actually wrote during this walk, as counted by the phone itself: walkMs, video {framesReceived, framesAppended, framesDropped, secondsSinceLastFrameArrived}, audio {buffersReceived, buffersAppended, buffersDropped, longestDropRun, secondsAppended, engineRestarts, standaloneSecondsRecorded, events[{atMs, kind}]}. Validated and bounded at the ingest route (shared/src/types/glasses-walk-capture-census.ts); unknown keys kept. NULL means the client did not send one. The first non-null census a walk is filed with is the one kept. The narration shortfall the deal page shows is derived from this at read time, never stored. Migration 0244.';
