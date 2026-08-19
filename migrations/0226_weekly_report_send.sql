-- Migration 0226: what a weekly report's SEND actually consisted of, and whether it reached the client.
--
-- 0225 is the highest number on origin/main and nothing above 0223 exists on any open weekly-report
-- branch, so 0226 is the next free one.
--
-- 0222 already gave `weekly_reports` `send_attempts`, `send_error`, `sent_at`, `version` and
-- `superseded_by_id`; none of those is re-added here. What was missing is everything that turns "the PM
-- pressed Send" into "the client received it":
--
--   • `send_request` — the composed email the PM actually approved: recipients, subject, the context
--     paragraph they edited, whether the PDF is attached, and the share URL. Stored rather than recomposed
--     in the worker for two reasons. A retry must re-send THE SAME message, not a message recomposed from
--     a setup row somebody has edited since. And the raw share token exists exactly once — it is returned
--     to the modal and never stored anywhere else, because only its SHA-256 hash lives in
--     public.weekly_report_tokens — so the URL the client is meant to open has to be carried forward with
--     the request or the email cannot contain a working link.
--
--   • `send_delivered_at` — when the mail provider ACCEPTED the message. Deliberately NOT `sent_at`:
--     `sent_at` is stamped by the API the moment the PM commits, because the dashboard, the per-project
--     "reports sent" counter and the status chip all read `status = 'sent'` and would otherwise disagree
--     with a row that has no timestamp. Delivery is a second, slower fact, and collapsing the two would
--     mean either a `sent` report with a null sent_at (the counters break) or a report that claims it was
--     delivered the instant somebody clicked a button (the failure this feature exists to surface becomes
--     invisible). Two facts, two columns.
--
--   • `send_delivery_key` — rotates the mail provider's idempotency key. The worker restarts routinely, so
--     "provider accepted, process died before the stamp" is an ordinary outcome; replaying the same key is
--     what stops that becoming a second email to a client. It is minted per SEND REQUEST, so a correction
--     (a new report row) gets its own and can genuinely go out, while a retry of the same request reuses
--     it and cannot double-send.
--
--   • `send_last_attempt_at` — when the delivery was last attempted. `send_attempts` alone cannot
--     distinguish "failed twice an hour ago and gave up" from "failed twice in the last minute and is
--     still retrying", which is the difference between a chip somebody must act on and one they should
--     leave alone. Written by the worker when an attempt FINISHES and by the API's retry route when one
--     is re-queued, so it is the clock the board ages a stalled send against: `sent_at` is stamped once
--     when the PM commits and never moves, which made every legitimate retry read as "Send stuck".
--
-- Per-office, like every weekly-report table bar the public share token. Skips any office without
-- `weekly_reports` — 0222 itself skips offices lacking `deals`/`files`, and an ALTER against a table that
-- was never created there would abort the whole migration for every office after it.
--
-- Idempotent / replayable: ADD COLUMN IF NOT EXISTS and CREATE INDEX IF NOT EXISTS throughout.

-- Existing tenants.
DO $tenant$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\_%' ESCAPE '\' ORDER BY nspname
  LOOP
    IF to_regclass(format('%I.weekly_reports', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE %I.weekly_reports
         ADD COLUMN IF NOT EXISTS send_request jsonb,
         ADD COLUMN IF NOT EXISTS send_delivery_key uuid,
         ADD COLUMN IF NOT EXISTS send_delivered_at timestamptz,
         ADD COLUMN IF NOT EXISTS send_last_attempt_at timestamptz',
      schema_name
    );

    -- The "Send failed" chip's row set, and the sweep any future dead-letter recovery would run: a report
    -- the PM has committed to sending which the client has not been proven to have received. Partial, so
    -- it stays tiny — in steady state it holds only the handful of sends currently in flight.
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS weekly_reports_send_undelivered_idx
         ON %I.weekly_reports (weekly_report_project_id, week_of)
        WHERE is_active AND status = ''sent'' AND send_delivered_at IS NULL',
      schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema).
-- Both halves are required. The DO loop above fixes the offices that already exist; without this block a
-- NEWLY provisioned office gets 0222's shape and none of these columns, and every send there fails on a
-- missing column the day someone sets up their first project.
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.weekly_reports
  ADD COLUMN IF NOT EXISTS send_request jsonb,
  ADD COLUMN IF NOT EXISTS send_delivery_key uuid,
  ADD COLUMN IF NOT EXISTS send_delivered_at timestamptz,
  ADD COLUMN IF NOT EXISTS send_last_attempt_at timestamptz;

CREATE INDEX IF NOT EXISTS weekly_reports_send_undelivered_idx
  ON office_dallas.weekly_reports (weekly_report_project_id, week_of)
  WHERE is_active AND status = 'sent' AND send_delivered_at IS NULL;
-- TENANT_SCHEMA_END
