-- Migration 0214: `glasses_walkthroughs` — the CRM's own record that a glasses walk exists, and which
-- TROCK Scope walkthrough it became.
--
-- 0211/0212/0213 are the glasses migrations already applied in production, so this is the next free number.
-- (0201 is used twice on disk; the runner tolerates that, but nothing here relies on it.)
--
-- WHY A TABLE AT ALL. Before this file the CRM held NO walkthrough record of any kind — no table matching
-- %walkthrough% existed in any office schema. Once a walk had been filed and forwarded, the ONLY thing
-- linking a deal to its TROCK Scope walkthrough was `public.job_queue.payload->>'scopeWalkthroughId'` on a
-- forward job. That is unusable as a read model for the deal page, for three independent reasons:
--   1. it is keyed by an integer job id the browser never sees, and finding a deal's walks means scanning
--      job payloads by `payload->>'dealId'` — a jsonb predicate on the busiest queue table in the install;
--   2. it is a QUEUE. Rows are dead-lettered, superseded, replaced and hand-edited during reconciliation
--      (see the supersede/inherit machinery in glasses-walkthrough-service.ts), so "which walks does this
--      deal have" would be answered by reasoning about job lifecycle rather than by reading a fact; and
--   3. a walk that is filed but not yet forwarded — the window between the completion committing and the
--      dedicated poller claiming the row — has no job payload to read at all, so the deal page would show
--      nothing for a walk the crew has already uploaded.
-- The row below is the fact: this deal has this walk, captured then, by them. `scope_walkthrough_id` is the
-- one part of it the CRM learns late.
--
-- PER-OFFICE (office_* schemas), not public. It is deal-scoped data — `deal_id` is a real FK into
-- `%I.deals`, which only exists per tenant — and every reader reaches it through the request's
-- `search_path` like every other deal-scoped table. Contrast public.field_ai_report_runs (0209), which is
-- public precisely because a WORKER has to resolve a row to its office BEFORE it can pick a search_path;
-- this table is never looked up by id alone.
--
-- WRITERS, and there are exactly two:
--   • `ingestGlassesWalkthrough` (server/src/modules/walkthrough-capture/glasses-walkthrough-service.ts)
--     inserts the row in the same transaction that writes the walk's `files` rows and enqueues the forward.
--   • `handleGlassesWalkthroughForward` (worker/src/jobs/glasses-walkthrough-forward.ts) stamps
--     `scope_walkthrough_id` once TROCK Scope's walkthrough id is known — the same value it already
--     checkpoints into its own job payload.
-- A BACKFILL IS INCLUDED, and an earlier draft of this comment argued it could not be — that the walks
-- already filed in production were unreconstructable, because `files` carries the walkId only inside a
-- `tags` array and the captured-by/captured-at pair belongs to the walk rather than to any one artifact.
-- That reasoning looked in the wrong place. The FORWARD JOB payload holds every field this table needs:
-- officeSlug, dealId, walkId, capturedAt, capturedByUserId, and any checkpointed scopeWalkthroughId.
--
-- It matters more than a tidy-up. A phone does not re-complete a walk it finished weeks ago, so without
-- the backfill those walks never get a row at all — including the one real hardware walk in production,
-- which is the walk this feature exists to show. See the DO-loop below.

DO $tenant$
DECLARE
  schema_name text;
BEGIN
  -- A CASTABLE-OR-NULL TIMESTAMP, because the uuid regex guards below are only half the problem.
  --
  -- `job_queue.payload` is unconstrained jsonb that reconciliation edits by hand, so `capturedAt` can hold
  -- any string at all. `IS NOT NULL` does not make it a timestamp: a bare `::timestamptz` on one bad value
  -- raises 22007 and — because every office is backfilled in this single DO block, in one transaction —
  -- aborts migration 0214 for EVERY tenant, not just the office holding the bad row. That is the same
  -- failure the uuid columns are already guarded against, on the one field that was left unguarded.
  --
  -- A REGEX WOULD NOT BE ENOUGH here, which is why this is a function rather than another `~*`. Bounding
  -- the fields (month 01-12, day 01-31) still admits `2026-02-30`, which is shaped like a date and throws
  -- on cast anyway. Only an actual attempted cast decides castability, and only an EXCEPTION block can
  -- catch the failure without taking the statement down with it.
  --
  -- `pg_temp` so it is session-local and disappears on its own — a migration has no business leaving a
  -- helper behind in a schema the application reads. Called fully qualified for the same reason the rest of
  -- this file is: `search_path` is not this block's to assume.
  --
  -- STABLE, not IMMUTABLE: parsing a timestamp without an offset depends on the TimeZone setting.
  --
  -- INFINITY IS REJECTED TOO, and it is not a cast failure — `'infinity'::timestamptz` is perfectly valid
  -- Postgres, so the EXCEPTION block never sees it. It has to be refused by VALUE. node-postgres hands
  -- those back as numeric Infinity, and `resolveGlassesWalkthroughScope` calls `row.capturedAt
  -- .toISOString()` on every row it returns — which throws a RangeError on a non-finite date. So a single
  -- hand-edited `"infinity"` would not corrupt one row quietly; it would make the AI-walk panel fail for
  -- that entire deal. A capture time of infinity is not a capture time, and null is the honest answer.
  EXECUTE $fn$
    CREATE OR REPLACE FUNCTION pg_temp.glasses_walkthrough_backfill_ts(value text)
    RETURNS timestamptz LANGUAGE plpgsql STABLE AS $body$
    DECLARE
      parsed timestamptz;
    BEGIN
      parsed := value::timestamptz;
      IF parsed = 'infinity'::timestamptz OR parsed = '-infinity'::timestamptz THEN
        RETURN NULL;
      END IF;
      RETURN parsed;
    EXCEPTION WHEN others THEN
      RETURN NULL;
    END;
    $body$
  $fn$;

  FOR schema_name IN
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\_%' ESCAPE '\' ORDER BY nspname
  LOOP
    IF to_regclass(format('%I.deals', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    -- deal_id ON DELETE CASCADE: this row is a LINK and is meaningless without its deal — matching
    -- field_scorecards (0172) / field_scorecard_edit_uploads (0185), the other per-office tables hung off a
    -- deal. captured_by_user_id ON DELETE SET NULL is the opposite trade and deliberately so: the actor is
    -- PROVENANCE on a historical record, so removing a user must neither delete the walk's link to a scope
    -- extraction somebody paid for nor be blocked by it. (`files.uploaded_by` is NOT NULL with a plain FK
    -- and therefore blocks the delete; that is a pre-existing choice, not one worth copying here.)
    --
    -- walk_id is varchar(100) because that is exactly MAX_WALK_ID_CHARS in
    -- glasses-walkthrough-service.ts, the validator every caller passes through. Pinning the width in the
    -- column keeps the two from drifting the way files.client_upload_id's varchar(64) pins its own
    -- validator, and it bounds the unique index key below.
    --
    -- captured_at is the walk's own capture time (the phone's clock at end-of-walk), NOT created_at. They
    -- differ by however long the upload took, which over jobsite cellular is routinely hours and can be
    -- days — a walk sorted by created_at is sorted by when the signal came back, which is not a fact about
    -- the site visit.
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.glasses_walkthroughs (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         deal_id uuid NOT NULL REFERENCES %I.deals(id) ON DELETE CASCADE,
         walk_id varchar(100) NOT NULL,
         scope_walkthrough_id uuid,
         captured_at timestamptz NOT NULL,
         captured_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now()
       )',
      schema_name, schema_name
    );

    -- THE IDEMPOTENCY MECHANISM, and the reason this index is UNIQUE rather than merely useful.
    --
    -- A walk is ingested more than once as a matter of course: mobile retries a completion whose response
    -- timed out in flight, and a recovered walk is re-filed from an on-disk directory scan. The completion
    -- is already idempotent per artifact (files.client_upload_id) and per walk (0213's live partial unique
    -- index on the forward job), so this row must be too, or one physical walk grows a second, third and
    -- fourth panel entry on the deal page — each of which the reader would then fan out to TROCK Scope for
    -- separately.
    --
    -- (deal_id, walk_id), never walk_id alone. walkId is minted on the PHONE and identifies a physical walk,
    -- not a piece of work; re-filing ONE walk against a SECOND deal is a supported correction flow (a
    -- mis-tagged walk moved to the right job; a recovered orphan whose deal a human supplies at recovery
    -- time). This is the same pair, for the same reason, that the R2 key derivation, the forward-job dedupe
    -- (0211/0213) and the TROCK Scope externalRef are all scoped by. Unique on walk_id alone, the second
    -- deal's completion would collide and that deal would never get a panel entry at all.
    --
    -- deal_id LEADS, so this index also serves the only read the panel endpoint makes — every walkthrough
    -- for one deal.
    -- No second index on (deal_id, captured_at): a deal has a handful of walks, so ordering them is a sort
    -- over single-digit rows, and an index earning nothing is still an index every insert maintains.
    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS glasses_walkthroughs_deal_walk_uidx
         ON %I.glasses_walkthroughs (deal_id, walk_id)',
      schema_name
    );

    -- BACKFILL FROM THE FORWARD JOBS, or this table is empty for every walk that already happened —
    -- including the one real hardware walk in production, which is the walk this whole feature exists
    -- to show. A row is only written by `ingestGlassesWalkthrough` from now on, and a phone does not
    -- re-complete a walk it finished weeks ago, so without this those walks are invisible on the deal
    -- page for ever rather than merely until something refreshes.
    --
    -- Every field is already in the payload the forwarder wrote: officeSlug decides the schema, and
    -- dealId / walkId / capturedAt / capturedByUserId / scopeWalkthroughId are the same values the
    -- ingest path would have inserted.
    --
    -- GUARDED, because a job payload is jsonb and constrains nothing:
    --   * the uuid columns take a value only when it LOOKS like one — a checkpoint repaired by hand can
    --     hold anything, and one malformed row must not abort a migration for every office;
    --   * the deal must still exist, or the FK fails on a walk whose deal was deleted;
    --   * DISTINCT ON keeps one row per (deal, walk) — a walk that dead-lettered and was replaced has
    --     several jobs — preferring the newest job that actually carries a scope id.
    -- Skipped when there is no queue to read, rather than assumed. `job_queue` is created in 0001 so it
    -- is always there on a real migration run; this keeps the statement from being the thing that decides
    -- whether 0214 can run at all in any context where it is not, which a backfill has no business doing.
    IF to_regclass('public.job_queue') IS NOT NULL THEN
    EXECUTE format(
      $bf$INSERT INTO %I.glasses_walkthroughs (deal_id, walk_id, scope_walkthrough_id, captured_at, captured_by_user_id)
         SELECT DISTINCT ON (deal_id, walk_id) deal_id, walk_id, scope_walkthrough_id, captured_at,
                -- THE CAPTURER MUST STILL EXIST. Looking like a uuid is not the same as being a live
                -- `public.users` row, and this column has a real FK. A user removed since the walk was
                -- forwarded — the exact case `ON DELETE SET NULL` exists to tolerate — would pass the regex
                -- and then violate the constraint, aborting the one tenant-wide DO block and taking 0214
                -- down for EVERY office. Nulled rather than skipped, because the WALK is still a fact worth
                -- showing; only its actor is unknown, which is precisely what the nullable column means.
                CASE WHEN EXISTS (SELECT 1 FROM public.users u WHERE u.id = candidates.captured_by_user_id)
                     THEN candidates.captured_by_user_id END AS captured_by_user_id
           FROM (
             SELECT (q.payload->>'dealId')::uuid AS deal_id,
                    q.payload->>'walkId' AS walk_id,
                    CASE WHEN q.payload->>'scopeWalkthroughId' ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
                         THEN (q.payload->>'scopeWalkthroughId')::uuid END AS scope_walkthrough_id,
                    pg_temp.glasses_walkthrough_backfill_ts(q.payload->>'capturedAt') AS captured_at,
                    CASE WHEN q.payload->>'capturedByUserId' ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
                         THEN (q.payload->>'capturedByUserId')::uuid END AS captured_by_user_id,
                    q.id AS job_id
               FROM public.job_queue q
              WHERE q.job_type = 'glasses_walkthrough_forward'
                AND q.payload->>'officeSlug' = %L
                AND q.payload->>'dealId' ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
                AND q.payload->>'walkId' IS NOT NULL
                AND q.payload->>'capturedAt' IS NOT NULL
           ) candidates
          WHERE captured_at IS NOT NULL
            AND EXISTS (SELECT 1 FROM %I.deals d WHERE d.id = candidates.deal_id)
          ORDER BY deal_id, walk_id, (scope_walkthrough_id IS NOT NULL) DESC, job_id DESC
       ON CONFLICT (deal_id, walk_id) DO NOTHING$bf$,
      -- THE LEADING PREFIX ONLY. `replace()` here removed EVERY occurrence, and an office slug may contain
      -- the prefix as a substring — the provisioner accepts `^[a-z][a-z0-9_]*$` (office/service.ts), so
      -- `north_office_1` is a legal slug whose schema is `office_north_office_1`. `replace` turned that back
      -- into `north_1`, which matches no payload, so the backfill silently skipped every historical walk for
      -- that office while reporting success. Anchored, it round-trips the provisioner's `office_${slug}`.
      schema_name, regexp_replace(schema_name, '^office_', ''), schema_name
    );
    END IF;
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner, which lifts the block between these markers and rewrites
-- `office_dallas` to the new schema name (server/src/modules/office/service.ts). It must stay in PARITY
-- with the DO-loop above — a table created only in the loop exists for today's offices and silently does
-- not exist for the next one provisioned, which is a 42P01 on a deal page nobody can reproduce.
-- TENANT_SCHEMA_START
CREATE TABLE IF NOT EXISTS office_dallas.glasses_walkthroughs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES office_dallas.deals(id) ON DELETE CASCADE,
  walk_id varchar(100) NOT NULL,
  scope_walkthrough_id uuid,
  captured_at timestamptz NOT NULL,
  captured_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS glasses_walkthroughs_deal_walk_uidx
  ON office_dallas.glasses_walkthroughs (deal_id, walk_id);
-- TENANT_SCHEMA_END
