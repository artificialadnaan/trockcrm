-- Migration 0242: CRM-receipt boundary for client-visible weekly-report delivery verdicts.
--
-- The provider timestamp in send_delivery_status_at says when the provider observed an event. It cannot
-- freeze portal pagination: a bounce observed yesterday may reach CRM between page one and page two
-- today. This column records when CRM learned the controlling verdict. The API samples the same
-- per-office advisory boundary before page one, so later webhook receipts cannot reshuffle that walk.
--
-- The statement trigger is a rolling-deploy compatibility guard. An older API image knows nothing about
-- this column, but every insert/update of the verdict fields still takes the boundary lock before row
-- locks and the row trigger stamps the receipt time. Taking the lock in a row trigger would invert the
-- reader's lock order (boundary, then rows) and create a deadlock during a mixed-version rollout.

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
         ADD COLUMN IF NOT EXISTS send_delivery_status_recorded_at timestamptz',
      schema_name
    );
    EXECUTE format(
      'UPDATE %I.weekly_reports
          SET send_delivery_status_recorded_at = clock_timestamp()
        WHERE send_delivery_status IS NOT NULL
          AND send_delivery_status_recorded_at IS NULL',
      schema_name
    );

    EXECUTE format('DROP TRIGGER IF EXISTS weekly_reports_delivery_boundary_insert_stmt ON %I.weekly_reports', schema_name);
    EXECUTE format('DROP TRIGGER IF EXISTS weekly_reports_delivery_boundary_update_stmt ON %I.weekly_reports', schema_name);
    EXECUTE format('DROP TRIGGER IF EXISTS weekly_reports_delivery_recorded_row ON %I.weekly_reports', schema_name);
    EXECUTE format(
      'CREATE TRIGGER weekly_reports_delivery_boundary_insert_stmt
         BEFORE INSERT ON %I.weekly_reports
         FOR EACH STATEMENT EXECUTE FUNCTION public.weekly_report_delivery_boundary_lock_v1()',
      schema_name
    );
    EXECUTE format(
      'CREATE TRIGGER weekly_reports_delivery_boundary_update_stmt
         BEFORE UPDATE OF send_delivery_status, send_delivery_status_at, send_delivery_detail,
                          send_delivery_status_recorded_at ON %I.weekly_reports
         FOR EACH STATEMENT EXECUTE FUNCTION public.weekly_report_delivery_boundary_lock_v1()',
      schema_name
    );
    EXECUTE format(
      'CREATE TRIGGER weekly_reports_delivery_recorded_row
         BEFORE INSERT OR UPDATE OF send_delivery_status, send_delivery_status_at, send_delivery_detail,
                                    send_delivery_status_recorded_at ON %I.weekly_reports
         FOR EACH ROW EXECUTE FUNCTION public.weekly_report_delivery_recorded_guard_v1()',
      schema_name
    );

    IF NOT EXISTS (
      SELECT 1
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = schema_name
         AND t.relname = 'weekly_reports'
         AND c.conname = 'weekly_reports_send_delivery_recorded_pair_check'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I.weekly_reports
           ADD CONSTRAINT weekly_reports_send_delivery_recorded_pair_check
           CHECK ((send_delivery_status IS NULL) =
                  (send_delivery_status_recorded_at IS NULL)) NOT VALID',
        schema_name
      );
    END IF;
    EXECUTE format(
      'ALTER TABLE %I.weekly_reports
         VALIDATE CONSTRAINT weekly_reports_send_delivery_recorded_pair_check',
      schema_name
    );
  END LOOP;
END $tenant$;

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
  BEFORE UPDATE OF send_delivery_status, send_delivery_status_at, send_delivery_detail,
                   send_delivery_status_recorded_at ON office_dallas.weekly_reports
  FOR EACH STATEMENT EXECUTE FUNCTION public.weekly_report_delivery_boundary_lock_v1();

CREATE TRIGGER weekly_reports_delivery_recorded_row
  BEFORE INSERT OR UPDATE OF send_delivery_status, send_delivery_status_at, send_delivery_detail,
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
