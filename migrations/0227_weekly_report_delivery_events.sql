-- Migration 0227: what the MAIL PROVIDER later said about a weekly report we had already handed it.
--
-- 0226 is the highest number in the tree and nothing above it exists on any open branch, so 0227 is next.
--
-- 0226 gave `weekly_reports.send_delivered_at`, whose meaning is precise and NARROW: the provider accepted
-- the message. That is the last thing the send path can observe while it is still running, and it is not
-- delivery. A report addressed to `jay@examle.com` is accepted, hard-bounces a minute later, and every
-- surface that reads acceptance alone shows it as fine forever — the client never gets their report and
-- nobody finds out. This migration adds the second, slower fact, which arrives out of band on a webhook.
--
-- `send_delivered_at` IS NOT REDEFINED AND IS NOT WRITTEN BY THE WEBHOOK. It still means "accepted", the
-- board, the History chip, the retry gate and `weekly_reports_send_undelivered_idx` all keep reading it
-- unchanged, and a bounce leaves it exactly where the worker put it. Two facts, two column sets — the same
-- decision 0226 made about `sent_at` versus `send_delivered_at`, for the same reason: collapsing them
-- would mean either losing "we handed it over successfully" or claiming delivery nothing can evidence.
--
--   • `send_delivery_status` — the provider's verdict:
--       delayed | delivered | complained | failed | bounced.
--     NULL means no webhook has spoken for this send yet, which is the state every row starts in and the
--     permanent state of every send made before this deploy (see the note on the tag below).
--
--   • `send_delivery_status_at` — THE PROVIDER'S OWN TIMESTAMP for the event that produced that verdict,
--     not the time we received it. This is the ordering key and it is the whole point of the column.
--     Webhooks arrive more than once and out of order: a provider retrying a `delivered` it could not hand
--     over lands it AFTER the `bounced` that superseded it, and a row ordered by arrival would resolve the
--     two backwards and go on claiming a bounced report reached the client. A verdict is replaced only by
--     one the provider dated later.
--
--   • `send_delivery_detail` — the bounce class (hard/soft), the provider's own bounce type/subtype, its
--     message and the provider's message id, kept verbatim. A hard bounce and a full mailbox call for
--     opposite actions from the PM, and re-deriving that from a status word later is not possible.
--
-- CORRELATION, and why there is a PUBLIC table.
--
-- `public.weekly_report_send_deliveries` maps a `send_delivery_key` to the office that minted it. A webhook
-- arrives with no session, no office header and no tenant context whatsoever, so it cannot choose a
-- search_path until something tells it which one — exactly the situation that put
-- `public.weekly_report_tokens` (0222) and `public.field_ai_report_runs` (0209) in `public`. The
-- alternative, fanning the key across every `office_*` schema on every event, is a cross-office scan on a
-- world-reachable endpoint and a way to read one office's data from another.
--
-- The key is minted PER SEND REQUEST by 0226, which is what makes it the right correlation handle and the
-- reason this does not key on a recomposed identity (recipient + subject + week): a correction goes to the
-- same client for the same week and would collapse into the original under any such scheme, so a bounce on
-- v1 would mark v2 undelivered. One row per send request; a retry reuses its key and inserts nothing new.
--
-- Idempotent / replayable throughout: IF NOT EXISTS on every object, and the CHECK is added only when
-- absent. That last guard is load-bearing rather than defensive — the DO loop below matches `office_dallas`
-- like any other office, so the TENANT block would otherwise try to add the same named constraint a second
-- time in this same file and abort the migration.

-- The delivery-key -> office map. PUBLIC, for the reason above. Written by the API inside the same
-- transaction as the `approved -> sent` transition, so a send that exists always has a row here.
CREATE TABLE IF NOT EXISTS public.weekly_report_send_deliveries (
  delivery_key uuid PRIMARY KEY,
  weekly_report_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  office_slug text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS weekly_report_send_deliveries_report_idx
  ON public.weekly_report_send_deliveries (weekly_report_id);

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
         ADD COLUMN IF NOT EXISTS send_delivery_status text,
         ADD COLUMN IF NOT EXISTS send_delivery_status_at timestamptz,
         ADD COLUMN IF NOT EXISTS send_delivery_detail jsonb',
      schema_name
    );

    IF NOT EXISTS (
      SELECT 1
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = schema_name
         AND t.relname = 'weekly_reports'
         AND c.conname = 'weekly_reports_send_delivery_status_check'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I.weekly_reports
           ADD CONSTRAINT weekly_reports_send_delivery_status_check
           CHECK (send_delivery_status IS NULL OR send_delivery_status IN
                  (''delayed'', ''delivered'', ''complained'', ''failed'', ''bounced''))',
        schema_name
      );
    END IF;

    -- Sends the provider has told us did NOT reach the client. Distinct from
    -- weekly_reports_send_undelivered_idx (0226), which is keyed on `send_delivered_at IS NULL` and by
    -- construction cannot contain any of these: a bounced report WAS accepted, so it carries a delivery
    -- stamp and sits outside that index entirely. Partial, so it stays tiny — in a healthy office it is
    -- empty.
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS weekly_reports_send_delivery_failed_idx
         ON %I.weekly_reports (weekly_report_project_id, week_of)
        WHERE is_active AND status = ''sent'' AND send_delivery_status IN (''bounced'', ''failed'')',
      schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema).
-- Both halves are required. The DO loop above fixes the offices that already exist; without this block a
-- NEWLY provisioned office gets 0226's shape and none of these columns, and the first bounce webhook for
-- that office fails on a missing column — silently, since a webhook has nobody to report to.
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.weekly_reports
  ADD COLUMN IF NOT EXISTS send_delivery_status text,
  ADD COLUMN IF NOT EXISTS send_delivery_status_at timestamptz,
  ADD COLUMN IF NOT EXISTS send_delivery_detail jsonb;

DO $tenant_check$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'office_dallas'
       AND t.relname = 'weekly_reports'
       AND c.conname = 'weekly_reports_send_delivery_status_check'
  ) THEN
    ALTER TABLE office_dallas.weekly_reports
      ADD CONSTRAINT weekly_reports_send_delivery_status_check
      CHECK (send_delivery_status IS NULL OR send_delivery_status IN
             ('delayed', 'delivered', 'complained', 'failed', 'bounced'));
  END IF;
END $tenant_check$;

CREATE INDEX IF NOT EXISTS weekly_reports_send_delivery_failed_idx
  ON office_dallas.weekly_reports (weekly_report_project_id, week_of)
  WHERE is_active AND status = 'sent' AND send_delivery_status IN ('bounced', 'failed');
-- TENANT_SCHEMA_END
