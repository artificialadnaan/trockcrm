-- CRM-side RFP integration fields used by the SyncHub RFP request job queue flow.
-- Idempotent across existing tenant schemas and reusable for future tenant schema provisioning.

DO $$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT nspname
      FROM pg_namespace
     WHERE nspname LIKE 'office\_%' ESCAPE '\'
  LOOP
    IF to_regclass(format('%I.deals', tenant_schema)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS rfp_approval_request_id integer', tenant_schema);
      EXECUTE format('ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS rfp_approval_token text', tenant_schema);
      EXECUTE format('ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS rfp_approval_status text', tenant_schema);
      EXECUTE format('ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS rfp_conflict_reason text', tenant_schema);
      EXECUTE format('ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS rfp_conflict_with jsonb', tenant_schema);
      EXECUTE format('ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS rfp_last_attempt_error text', tenant_schema);
      EXECUTE format('ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS estimator text', tenant_schema);
      EXECUTE format('ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS bid_due_date timestamptz', tenant_schema);
      EXECUTE format('ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS property_country text', tenant_schema);
    END IF;
  END LOOP;
END $$;

-- TENANT_SCHEMA_START
DO $tenant$
BEGIN
  IF to_regclass('deals') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE deals ADD COLUMN IF NOT EXISTS rfp_approval_request_id integer;
  ALTER TABLE deals ADD COLUMN IF NOT EXISTS rfp_approval_token text;
  ALTER TABLE deals ADD COLUMN IF NOT EXISTS rfp_approval_status text;
  ALTER TABLE deals ADD COLUMN IF NOT EXISTS rfp_conflict_reason text;
  ALTER TABLE deals ADD COLUMN IF NOT EXISTS rfp_conflict_with jsonb;
  ALTER TABLE deals ADD COLUMN IF NOT EXISTS rfp_last_attempt_error text;
  ALTER TABLE deals ADD COLUMN IF NOT EXISTS estimator text;
  ALTER TABLE deals ADD COLUMN IF NOT EXISTS bid_due_date timestamptz;
  ALTER TABLE deals ADD COLUMN IF NOT EXISTS property_country text;
END
$tenant$;
-- TENANT_SCHEMA_END
