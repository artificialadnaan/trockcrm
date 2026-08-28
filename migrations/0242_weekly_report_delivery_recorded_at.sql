-- Migration 0242: CRM-receipt boundaries for client-visible weekly-report publication.
--
-- Provider clocks cannot freeze portal pagination. A historical acceptance can be imported after page
-- one, and a bounce observed yesterday can reach CRM between page one and page two today. The two
-- `*_recorded_at` columns therefore say when CRM published the acceptance and when CRM learned the
-- controlling verdict. Page one samples the same per-office advisory boundary.
--
-- The statement triggers are rolling-deploy compatibility guards. Inserts and acceptance updates take
-- the blocking boundary lock before row locks. An old webhook image is the exception: it already holds
-- the report row before issuing its verdict UPDATE. Its verdict statement uses a non-blocking lock and
-- aborts with a retryable serialization error if another transaction owns the boundary. Waiting there
-- would create `acceptance: boundary -> row` / `old webhook: row -> boundary` deadlocks.
--
-- Existing tenants are deliberately NOT changed by a cross-office DO loop. The migration runner installs
-- the public functions/fence once, then calls the marked tenant installer in one transaction PER OFFICE.

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

CREATE OR REPLACE FUNCTION public.weekly_report_delivery_boundary_try_lock_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $delivery_boundary_try$
BEGIN
  IF NOT pg_try_advisory_xact_lock(
    hashtextextended(
      'weekly-report-core-client-delivery-boundary:v1:' || TG_TABLE_SCHEMA,
      0
    )
  ) THEN
    RAISE EXCEPTION 'weekly-report delivery boundary is busy; retry the verdict write'
      USING ERRCODE = '40001';
  END IF;
  RETURN NULL;
END $delivery_boundary_try$;

CREATE OR REPLACE FUNCTION public.weekly_report_delivery_recorded_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $delivery_recorded$
DECLARE
  acceptance_recorded_at timestamptz;
BEGIN
  -- Preserve an imported provider acceptance timestamp for display, but stamp when the accepted row
  -- became visible to CRM history. A live NULL -> accepted update owns both clocks after the statement
  -- boundary, replacing an old worker's transaction-start NOW() with a commit-ordered wall clock.
  IF NEW.send_delivered_at IS NULL THEN
    NEW.send_acceptance_recorded_at := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    NEW.send_acceptance_recorded_at := clock_timestamp();
  ELSIF OLD.send_delivered_at IS NULL THEN
    acceptance_recorded_at := clock_timestamp();
    NEW.send_delivered_at := acceptance_recorded_at;
    NEW.send_acceptance_recorded_at := acceptance_recorded_at;
  ELSE
    NEW.send_delivered_at := OLD.send_delivered_at;
    NEW.send_acceptance_recorded_at := OLD.send_acceptance_recorded_at;
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
    -- A later failed/bounced event may refine provider facts, but CRM already knew the send failed.
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

-- Shared by the existing-office runner, the current provisioner and the durable public.offices fence.
CREATE OR REPLACE FUNCTION public.install_weekly_report_delivery_boundary_v1(target_schema text)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $install_delivery_boundary$
DECLARE
  reports_relation regclass;
BEGIN
  IF target_schema IS NULL OR target_schema !~ '^office_[a-z][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'Cannot install weekly-report delivery boundary for invalid schema "%"', target_schema;
  END IF;

  reports_relation := to_regclass(format('%I.weekly_reports', target_schema));
  IF reports_relation IS NULL THEN
    RAISE EXCEPTION 'Office schema "%" has no weekly_reports table', target_schema;
  END IF;

  EXECUTE format(
    'ALTER TABLE %1$I.weekly_reports
       ADD COLUMN IF NOT EXISTS send_acceptance_recorded_at timestamptz,
       ADD COLUMN IF NOT EXISTS send_delivery_status_recorded_at timestamptz',
    target_schema
  );
  EXECUTE format(
    'UPDATE %1$I.weekly_reports
        SET send_acceptance_recorded_at = clock_timestamp()
      WHERE send_delivered_at IS NOT NULL
        AND send_acceptance_recorded_at IS NULL',
    target_schema
  );
  EXECUTE format(
    'UPDATE %1$I.weekly_reports
        SET send_delivery_status_recorded_at = clock_timestamp()
      WHERE send_delivery_status IS NOT NULL
        AND send_delivery_status_recorded_at IS NULL',
    target_schema
  );

  EXECUTE format(
    'DROP TRIGGER IF EXISTS weekly_reports_delivery_boundary_insert_stmt ON %I.weekly_reports',
    target_schema
  );
  EXECUTE format(
    'DROP TRIGGER IF EXISTS weekly_reports_delivery_boundary_update_stmt ON %I.weekly_reports',
    target_schema
  );
  EXECUTE format(
    'DROP TRIGGER IF EXISTS weekly_reports_delivery_boundary_acceptance_update_stmt ON %I.weekly_reports',
    target_schema
  );
  EXECUTE format(
    'DROP TRIGGER IF EXISTS weekly_reports_delivery_boundary_verdict_update_stmt ON %I.weekly_reports',
    target_schema
  );
  EXECUTE format(
    'DROP TRIGGER IF EXISTS weekly_reports_delivery_recorded_row ON %I.weekly_reports',
    target_schema
  );

  EXECUTE format(
    'CREATE TRIGGER weekly_reports_delivery_boundary_insert_stmt
       BEFORE INSERT ON %1$I.weekly_reports
       FOR EACH STATEMENT EXECUTE FUNCTION public.weekly_report_delivery_boundary_lock_v1()',
    target_schema
  );
  EXECUTE format(
    'CREATE TRIGGER weekly_reports_delivery_boundary_acceptance_update_stmt
       BEFORE UPDATE OF send_delivered_at, send_acceptance_recorded_at ON %1$I.weekly_reports
       FOR EACH STATEMENT EXECUTE FUNCTION public.weekly_report_delivery_boundary_lock_v1()',
    target_schema
  );
  EXECUTE format(
    'CREATE TRIGGER weekly_reports_delivery_boundary_verdict_update_stmt
       BEFORE UPDATE OF send_delivery_status, send_delivery_status_at, send_delivery_detail,
                        send_delivery_status_recorded_at ON %1$I.weekly_reports
       FOR EACH STATEMENT EXECUTE FUNCTION public.weekly_report_delivery_boundary_try_lock_v1()',
    target_schema
  );
  EXECUTE format(
    'CREATE TRIGGER weekly_reports_delivery_recorded_row
       BEFORE INSERT OR UPDATE OF send_delivered_at, send_acceptance_recorded_at,
                                  send_delivery_status, send_delivery_status_at, send_delivery_detail,
                                  send_delivery_status_recorded_at ON %1$I.weekly_reports
       FOR EACH ROW EXECUTE FUNCTION public.weekly_report_delivery_recorded_guard_v1()',
    target_schema
  );

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = target_schema
       AND t.relname = 'weekly_reports'
       AND c.conname = 'weekly_reports_send_acceptance_recorded_pair_check'
  ) THEN
    EXECUTE format(
      'ALTER TABLE %1$I.weekly_reports
         ADD CONSTRAINT weekly_reports_send_acceptance_recorded_pair_check
         CHECK ((send_delivered_at IS NULL) =
                (send_acceptance_recorded_at IS NULL)) NOT VALID',
      target_schema
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = target_schema
       AND t.relname = 'weekly_reports'
       AND c.conname = 'weekly_reports_send_delivery_recorded_pair_check'
  ) THEN
    EXECUTE format(
      'ALTER TABLE %1$I.weekly_reports
         ADD CONSTRAINT weekly_reports_send_delivery_recorded_pair_check
         CHECK ((send_delivery_status IS NULL) =
                (send_delivery_status_recorded_at IS NULL)) NOT VALID',
      target_schema
    );
  END IF;

  EXECUTE format(
    'ALTER TABLE %1$I.weekly_reports
       VALIDATE CONSTRAINT weekly_reports_send_acceptance_recorded_pair_check',
    target_schema
  );
  EXECUTE format(
    'ALTER TABLE %1$I.weekly_reports
       VALIDATE CONSTRAINT weekly_reports_send_delivery_recorded_pair_check',
    target_schema
  );
END $install_delivery_boundary$;

-- Install this fence before discovering existing offices. CREATE TRIGGER serializes with an older
-- provisioner that inserted first, so the subsequent scan sees it. An older provisioner that inserts
-- afterward receives the deferred event at COMMIT, after its weekly_reports table exists.
CREATE OR REPLACE FUNCTION public.provision_weekly_report_delivery_boundary_after_office_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $provision_delivery_boundary$
BEGIN
  IF NEW.slug IS NULL OR NEW.slug !~ '^[a-z][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'Cannot provision weekly-report delivery boundary for invalid office slug "%"', NEW.slug;
  END IF;
  PERFORM public.install_weekly_report_delivery_boundary_v1('office_' || NEW.slug);
  RETURN NULL;
END $provision_delivery_boundary$;

DROP TRIGGER IF EXISTS weekly_report_delivery_boundary_on_office_provision ON public.offices;
CREATE CONSTRAINT TRIGGER weekly_report_delivery_boundary_on_office_provision
AFTER INSERT ON public.offices
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.provision_weekly_report_delivery_boundary_after_office_v1();

-- TENANT_SCHEMA_START
SELECT public.install_weekly_report_delivery_boundary_v1('office_dallas');
-- TENANT_SCHEMA_END
