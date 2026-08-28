-- Migration 0242: CRM-receipt boundary for client-visible weekly-report delivery verdicts.
--
-- The provider timestamp in send_delivery_status_at says when the provider observed an event. It cannot
-- freeze portal pagination: a bounce observed yesterday may reach CRM between page one and page two
-- today. This column records when CRM learned the controlling verdict. The API samples the same
-- per-office advisory boundary before page one, so later webhook receipts cannot reshuffle that walk.
--
-- The statement trigger is a rolling-deploy compatibility guard. An older API/worker image knows nothing
-- about this boundary, but every insert/update of the acceptance or verdict fields still takes the lock
-- before row locks. The row trigger then samples acceptance/receipt time after that lock. Taking the lock
-- in a row trigger would invert the reader's lock order (boundary, then rows) and create a deadlock during
-- a mixed-version rollout.
--
-- Existing tenants are deliberately NOT changed by a cross-office DO loop in this file. The migration
-- runner installs the two public functions below once, then applies the tenant DDL/backfill/validation in
-- one transaction PER OFFICE. A migration file is one implicit transaction; doing the backfill here would
-- retain every earlier office's table and row locks until the last office finished.

CREATE OR REPLACE FUNCTION public.weekly_report_delivery_boundary_lock_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $delivery_boundary$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'weekly-report-core-client-delivery-boundary:v1:' || TG_TABLE_SCHEMA,
      0
    )
  );
  RETURN NULL;
END $delivery_boundary$;

CREATE OR REPLACE FUNCTION public.weekly_report_delivery_recorded_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $delivery_recorded$
BEGIN
  -- `send_delivered_at` is the provider-acceptance publication clock. A worker transaction can begin,
  -- wait on this migration's statement-level boundary lock, and still evaluate NOW() to its older
  -- transaction-start time. Own the null -> accepted transition in the database and sample the wall clock
  -- only after the statement trigger acquired that lock. Then commit order and the pagination boundary
  -- agree even while an old worker image is still writing NOW(). Once accepted, unrelated updates cannot
  -- rewrite the clock; an explicit reset to NULL remains possible for the send lifecycle.
  -- Application sends always publish acceptance by updating an existing sent row. Historical/import
  -- inserts may legitimately carry the provider's original acceptance timestamp, so only own the live
  -- NULL -> non-NULL update that participates in this pagination race.
  IF TG_OP = 'UPDATE'
     AND NEW.send_delivered_at IS NOT NULL
     AND OLD.send_delivered_at IS NULL THEN
    NEW.send_delivered_at := clock_timestamp();
  ELSIF TG_OP = 'UPDATE'
        AND OLD.send_delivered_at IS NOT NULL
        AND NEW.send_delivered_at IS NOT NULL THEN
    NEW.send_delivered_at := OLD.send_delivered_at;
  END IF;

  IF NEW.send_delivery_status IS NULL THEN
    NEW.send_delivery_status_recorded_at := NULL;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' OR OLD.send_delivery_status IS NULL THEN
    NEW.send_delivery_status_recorded_at := clock_timestamp();
    RETURN NEW;
  END IF;

  IF NEW.send_delivery_status IS DISTINCT FROM OLD.send_delivery_status
     OR NEW.send_delivery_status_at IS DISTINCT FROM OLD.send_delivery_status_at
     OR NEW.send_delivery_detail IS DISTINCT FROM OLD.send_delivery_detail THEN
    -- A later failed/bounced event may refine the provider facts, but CRM already knew the send had
    -- failed. Preserve that first-known boundary so an old walk cannot re-admit the row.
    IF OLD.send_delivery_status IN ('bounced', 'failed')
       AND NEW.send_delivery_status IN ('bounced', 'failed')
       AND OLD.send_delivery_status_recorded_at IS NOT NULL THEN
      NEW.send_delivery_status_recorded_at := OLD.send_delivery_status_recorded_at;
    ELSE
      NEW.send_delivery_status_recorded_at := clock_timestamp();
    END IF;
  ELSE
    -- The database owns this clock. Ignore attempts to edit only the receipt stamp.
    NEW.send_delivery_status_recorded_at := OLD.send_delivery_status_recorded_at;
  END IF;

  RETURN NEW;
END $delivery_recorded$;

-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.weekly_reports
  ADD COLUMN IF NOT EXISTS send_delivery_status_recorded_at timestamptz;

UPDATE office_dallas.weekly_reports
   SET send_delivery_status_recorded_at = clock_timestamp()
 WHERE send_delivery_status IS NOT NULL
   AND send_delivery_status_recorded_at IS NULL;

DROP TRIGGER IF EXISTS weekly_reports_delivery_boundary_insert_stmt ON office_dallas.weekly_reports;
DROP TRIGGER IF EXISTS weekly_reports_delivery_boundary_update_stmt ON office_dallas.weekly_reports;
DROP TRIGGER IF EXISTS weekly_reports_delivery_recorded_row ON office_dallas.weekly_reports;

CREATE TRIGGER weekly_reports_delivery_boundary_insert_stmt
  BEFORE INSERT ON office_dallas.weekly_reports
  FOR EACH STATEMENT EXECUTE FUNCTION public.weekly_report_delivery_boundary_lock_v1();

CREATE TRIGGER weekly_reports_delivery_boundary_update_stmt
  BEFORE UPDATE OF send_delivered_at, send_delivery_status, send_delivery_status_at, send_delivery_detail,
                   send_delivery_status_recorded_at ON office_dallas.weekly_reports
  FOR EACH STATEMENT EXECUTE FUNCTION public.weekly_report_delivery_boundary_lock_v1();

CREATE TRIGGER weekly_reports_delivery_recorded_row
  BEFORE INSERT OR UPDATE OF send_delivered_at, send_delivery_status, send_delivery_status_at, send_delivery_detail,
                             send_delivery_status_recorded_at ON office_dallas.weekly_reports
  FOR EACH ROW EXECUTE FUNCTION public.weekly_report_delivery_recorded_guard_v1();

DO $tenant_check$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'office_dallas'
       AND t.relname = 'weekly_reports'
       AND c.conname = 'weekly_reports_send_delivery_recorded_pair_check'
  ) THEN
    ALTER TABLE office_dallas.weekly_reports
      ADD CONSTRAINT weekly_reports_send_delivery_recorded_pair_check
      CHECK ((send_delivery_status IS NULL) =
             (send_delivery_status_recorded_at IS NULL)) NOT VALID;
  END IF;
END $tenant_check$;

ALTER TABLE office_dallas.weekly_reports
  VALIDATE CONSTRAINT weekly_reports_send_delivery_recorded_pair_check;
-- TENANT_SCHEMA_END
