-- Migration 0227: WHETHER ANYBODY HAS ALREADY BEEN TOLD THIS SEND STOPPED MOVING.
--
-- 0226 is the highest number in the tree and nothing above it exists on any open weekly-report branch, so
-- 0227 is the next free one.
--
-- 0226 gave the board everything it needs to SURFACE an undelivered send — `send_delivered_at`,
-- `send_last_attempt_at`, and the partial index that makes the undelivered set cheap to scan. What it did
-- not give anyone is a way to be TOLD. The worker's dead-letter sweep closes that gap, and the one thing it
-- needs from the schema is a memory of what it has already said:
--
--   • `send_stall_alerted_at` — when this delivery's stall was last alerted on. NULL means "nobody has been
--     told", which is what makes the sweep alert on the TRANSITION into stalled rather than on every pass.
--     A sweep that emails leadership every fifteen minutes about the same stuck report is a sweep whose
--     recipients build a filter rule for it inside a day, and then the next real failure is invisible for
--     exactly the same reason it was before this feature existed.
--
-- WHY A COLUMN ON `weekly_reports` AND NOT A ROW IN `weekly_report_reminders_sent`. That ledger is keyed
-- (weekly_report_project_id, week_of, kind), and the suppression this needs is PER REPORT: a correction is
-- a NEW report row for the SAME project and the SAME week, so a project+week key would silently swallow
-- the alert for a correction that stalls after the original already alerted — the one case where a client
-- has now been failed twice. Keying on the report id makes that structural. It also keeps the sweep's read
-- inside the row set 0226's partial index already covers, with no join.
--
-- WHO CLEARS IT. `retryWeeklyReportSend` does, in the same statement that moves `send_last_attempt_at`,
-- because a human retry is a transition OUT of stalled and its failure is a NEW incident somebody has to
-- hear about. The worker's automatic attempts deliberately do NOT clear it: the queue's three retries all
-- land inside 40 seconds, long before the stall threshold, so clearing there would only re-arm the alert
-- for the same unattended failure over and over. A correction needs no clearing at all — it is a fresh row
-- whose column starts NULL, and `createWeeklyReportCorrection` copies an explicit column list that has
-- never included the send_* family.
--
-- Per-office, like every weekly-report table bar the public share token. Skips any office without
-- `weekly_reports`, exactly as 0226 does: an ALTER against a table that was never created there would abort
-- the whole migration for every office after it.
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
         ADD COLUMN IF NOT EXISTS send_stall_alerted_at timestamptz',
      schema_name
    );

    -- The sweep's row set: an undelivered send NOBODY HAS BEEN TOLD ABOUT. Narrower than 0226's index
    -- (which the board still uses to render the chip for every undelivered send, alerted or not), and kept
    -- partial for the same reason — in steady state it holds only the handful of sends currently in
    -- flight, and every pass of the sweep reads it.
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS weekly_reports_send_unalerted_idx
         ON %I.weekly_reports (weekly_report_project_id, week_of)
        WHERE is_active AND status = ''sent'' AND send_delivered_at IS NULL
          AND send_stall_alerted_at IS NULL',
      schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema).
-- Both halves are required. The DO loop above fixes the offices that already exist; without this block a
-- NEWLY provisioned office gets 0226's shape and not this column, and the sweep's very first pass there
-- throws 42703 for that office on every tick — silently, since one office's failure must not stop the
-- others, so the alerting simply never happens in the office nobody has checked yet.
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.weekly_reports
  ADD COLUMN IF NOT EXISTS send_stall_alerted_at timestamptz;

CREATE INDEX IF NOT EXISTS weekly_reports_send_unalerted_idx
  ON office_dallas.weekly_reports (weekly_report_project_id, week_of)
  WHERE is_active AND status = 'sent' AND send_delivered_at IS NULL
    AND send_stall_alerted_at IS NULL;
-- TENANT_SCHEMA_END
