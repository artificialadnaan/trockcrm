-- Status ledger for AI-authored T Rock Cam photo reports ("AI Report" on the mobile Build-report screen).
--
-- WHY a table at all: a 40-photo Claude vision pass takes 30-90s, far past any sane HTTP request budget, so
-- the mobile button enqueues a public.job_queue row and polls instead of blocking. job_queue itself is a poor
-- status surface for the phone — it is keyed by an integer id the client never sees, its payload is opaque,
-- and completed rows are retained forever — so this table is the one thing mobile polls: one row per tap,
-- addressed by an opaque uuid, carrying the terminal outcome (file_id | error).
--
-- PUBLIC (not per-office), mirroring public.bid_board_ingestion_inbox (0188) and public.job_queue: a single
-- worker process serves every office, and the poller must resolve a run id to its office BEFORE it can pick a
-- search_path. A per-tenant table would force the status endpoint to fan out across every office schema just
-- to find one row. office_id/office_slug are therefore carried on the row itself — office_slug is what the
-- report's R2 key is built from, and re-deriving it later must not depend on the caller's active office.
--
-- deal_id and file_id deliberately have NO foreign key: both live in the per-office tenant schema
-- (office_<slug>.deals / .files) and cannot be referenced from public. Same trade-off job_queue already makes
-- by carrying tenant ids inside its jsonb payload. requested_by CAN be a real FK — public.users is shared.
CREATE TABLE IF NOT EXISTS public.field_ai_report_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id       uuid NOT NULL,                                  -- office_<slug>.deals.id (no FK: cross-schema)
  office_id     uuid NOT NULL REFERENCES public.offices(id),
  office_slug   text NOT NULL,                                  -- resolved at enqueue; builds the report R2 key
  requested_by  uuid NOT NULL REFERENCES public.users(id),      -- authorizes the status poll
  -- The selection, in PRINT ORDER (see below). Bounded HERE and not only in the route: the worker reads this
  -- column straight back out and hands every element to the model, so this is where the per-report spend is
  -- actually capped. The ceiling matches AI_REPORT_MAX_PHOTOS in server/src/modules/field/routes.ts.
  photo_ids     uuid[] NOT NULL CHECK (cardinality(photo_ids) BETWEEN 1 AND 60),
  report_title  text,
  -- Optional free-text scope from the requester ("focus on the roof drainage, ignore the interior punch
  -- list"). Kept on the row rather than only in the job payload because it is the single biggest determinant
  -- of what the report says — when a report comes back off-topic this column is the evidence for why.
  focus_prompt  text,
  status        text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  file_id       uuid,                                           -- office_<slug>.files.id of the rendered PDF
  error         text,                                           -- user-facing failure reason when status='failed'
  -- Usage/cost telemetry, mirroring the per-call accounting in worker/src/jobs/call-recording-transcribe.ts.
  -- Recorded even on failure when the model call itself succeeded, so a run that dies during PDF render is
  -- still attributable. Nullable: a run that fails before the first model call has nothing to report.
  model         text,
  input_tokens  integer,
  output_tokens integer,
  cost_usd      numeric(12, 6),
  started_at    timestamptz,
  finished_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- photo_ids order IS the report's print order: the AI is handed the photographs in this exact sequence and
-- returns findings indexed against it, so re-sorting this array would silently mis-caption every photo.

-- ONE in-flight run per (project, requester). Every tap of "AI Report" buys a real Claude vision pass over
-- up to 60 photographs, and the field routes are not behind apiLimiter — an impatient double-tap on a slow
-- connection would otherwise queue a second paid run and file a duplicate PDF for one intent.
--
-- Enforced as a partial UNIQUE INDEX rather than a SELECT-then-INSERT check on purpose: a pre-insert
-- snapshot is not authoritative under concurrency (two taps can both read "none in flight" before either
-- commits). The route catches the resulting unique violation and hands back the run already in flight, so a
-- double-tap polls the first run instead of erroring.
-- It is also the ONLY index this table needs: every other statement the feature runs is keyed on the primary
-- key, and this one covers the (deal_id, requested_by, status) lookups that the enqueue path performs. A
-- second index on (deal_id, created_at) was dropped before merge — nothing queried it, and it would have
-- cost a B-tree maintenance write on every insert and every status transition for no reader.
CREATE UNIQUE INDEX IF NOT EXISTS field_ai_report_runs_inflight_uidx
  ON public.field_ai_report_runs (deal_id, requested_by)
  WHERE status IN ('queued', 'running');
