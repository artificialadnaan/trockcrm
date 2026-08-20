-- Migration 0231: record every fetch of a client's weekly-report link.
--
-- 0230 is the highest number on this stack, so 0231 is the next free one.
--
-- WHY. "We never received that report" is a claim the CRM currently cannot answer. It knows the message
-- was composed, that the provider accepted it, and what the provider said afterwards — and then nothing.
-- Whether anyone at the client ever opened the thing is unrecorded.
--
-- PUBLIC, not per-office, for the same reason `weekly_report_tokens` is: a share link is resolved before
-- any tenant is known, by a route that has only the token. Carrying `tenant_id` and `office_slug` on the
-- row keeps it queryable per office afterwards, exactly as the tokens table does.
--
-- WHAT IS DELIBERATELY *NOT* STORED HERE: a verdict.
--
-- Corporate email security — Proofpoint, Mimecast, Microsoft Defender, Barracuda — fetches every link in
-- an inbound message within seconds of delivery. On a commercial client that is close to certain, so a
-- naive "opened_at" would show an open on essentially every report whether or not a human ever looked.
-- In a dispute that is worse than no log at all: asserting "your team opened this at 9:02" when it was a
-- scanner in a datacentre discredits the rest of the trail with it.
--
-- So this table stores only OBSERVATIONS — when, from where, with what, and which asset was fetched —
-- and the person/scanner judgement is made at READ time by one shared classifier. Two reasons that way
-- round: the judgement improves without a backfill, and it can use facts that arrive AFTER the row is
-- written. Whether a visitor went on to load the photographs or download the PDF is the single strongest
-- signal that they were a person, and it is unknowable at the moment the page fetch is logged.
--
-- RETENTION is 24 months, enforced by the sweep in the worker rather than by this migration. Construction
-- disputes routinely surface a year or more after the fact, which is the window this exists to serve.

CREATE TABLE IF NOT EXISTS public.weekly_report_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The report itself, so the audit trail can be assembled even after every token for it is revoked.
  weekly_report_id uuid NOT NULL,
  -- WHICH link was used. Nullable and NOT a foreign key: a token row may be deleted by a future cleanup,
  -- and losing the record of an access because the link it used was tidied away defeats the point.
  token_id uuid,

  tenant_id uuid,
  office_slug text,

  -- `page` is the client-facing HTML, `pdf` the attachment download, `photo` one image within the page.
  -- Photos are logged too, unsummarised, because they are what distinguishes a human session from a
  -- scanner that fetched the URL once and left — the read side groups them into sessions.
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),

  -- `inet` rather than text: it is the right type, it normalises v4 and v6, and it makes a future
  -- "was this that office's network" question answerable with a subnet containment operator.
  ip inet,
  user_agent text,
  -- The `Referer`, when the browser sends one. Occasionally the only thing distinguishing a link opened
  -- from the email from one pasted into a chat and opened by somebody else entirely.
  referrer text,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT weekly_report_views_event_type_check
    CHECK (event_type IN ('page', 'pdf', 'photo'))
);

-- The audit trail's own read: every access to one report, newest first.
CREATE INDEX IF NOT EXISTS weekly_report_views_report_idx
  ON public.weekly_report_views (weekly_report_id, occurred_at DESC);

-- The retention sweep's read, and nothing else. Kept separate from the index above so the purge does not
-- have to walk a report-ordered index to find the oldest rows.
CREATE INDEX IF NOT EXISTS weekly_report_views_occurred_idx
  ON public.weekly_report_views (occurred_at);

-- NO TENANT_SCHEMA BLOCK, deliberately, and this is the one migration in the feature where its absence is
-- correct rather than an omission. The table is in `public` — a newly provisioned office shares it the
-- moment it exists, exactly as it shares `weekly_report_tokens`. Adding a per-office copy would give each
-- office its own access log that the public route, which has no tenant context, could not choose between.
