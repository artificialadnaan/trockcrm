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
  -- The office-authorisation rule THIS run was accepted under, captured at enqueue.
  --
  -- The API and the worker are separate processes reading their own FIELD_CROSS_OFFICE_WRITES_ENABLED, and
  -- the flag can change while a run sits queued. Re-reading it in the worker judges the run by a rule it was
  -- never accepted under, in BOTH directions: a run enqueued while a grant was required could skip
  -- revalidation and publish after that grant was revoked, and a cross-office run legitimately accepted
  -- without one could be rejected after the model spend had already happened. Storing the decision makes the
  -- two ends agree by construction. Defaults to true, the conservative rule.
  office_grant_required boolean NOT NULL DEFAULT true,
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
-- It also carries the in-flight reads the feature performs. The concurrent-run check and the stale-run sweep
-- filter on requested_by + status WITHOUT a deal_id, so they cannot use this index for a direct lookup. They
-- do not need one: the index is PARTIAL, so it holds only queued/running rows (bounded by
-- users x MAX_IN_FLIGHT_RUNS_PER_USER) even as the table accumulates every terminal run ever made.
CREATE UNIQUE INDEX IF NOT EXISTS field_ai_report_runs_inflight_uidx
  ON public.field_ai_report_runs (deal_id, requested_by)
  WHERE status IN ('queued', 'running');

-- The rolling daily cap is the one read the partial index above CANNOT serve, and the reason this table
-- needs a second index at all. It counts a user's runs in the last 24 hours across EVERY status, so it walks
-- terminal rows — and this ledger is never pruned, so that set grows without bound for the life of the
-- install. Unindexed it degrades from trivial to a full scan of one user's entire history, inside the
-- enqueue transaction that already holds an advisory lock and runs under a 30-second statement timeout:
-- starting a report would get slower every week and eventually just fail.
-- created_at DESC so the 24-hour window is a leading-edge range scan rather than a walk to the tail.
CREATE INDEX IF NOT EXISTS field_ai_report_runs_requester_recent_idx
  ON public.field_ai_report_runs (requested_by, created_at DESC);

-- The two IN-FLIGHT predicates — the concurrency check inside insertAiReportRunTx and the stale sweep in
-- expireStaleAiReportRuns, which runs on EVERY enqueue — are keyed on requested_by + status, not on a date.
-- The index above answers them, but only by scanning all of that requester's history and filtering: correct,
-- and unbounded, on a ledger that is never pruned. Partial on the two live statuses, so it holds at most
-- MAX_IN_FLIGHT_RUNS_PER_USER rows per user however long the install runs, and rows leave it the moment they
-- reach a terminal state.
CREATE INDEX IF NOT EXISTS field_ai_report_runs_requester_inflight_idx
  ON public.field_ai_report_runs (requested_by)
  WHERE status IN ('queued', 'running');
