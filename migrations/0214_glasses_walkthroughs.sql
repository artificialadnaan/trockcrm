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
-- Nothing else writes it, and no backfill is included: rows for the walks already filed in production
-- cannot be reconstructed here, because `files` carries the walkId only inside a `tags` array and the
-- captured-by/captured-at pair belongs to the walk rather than to any one artifact. The next completion
-- retry from a phone files them correctly; anything older is a one-off script decision, not a schema one.

DO $tenant$
DECLARE
  schema_name text;
BEGIN
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
