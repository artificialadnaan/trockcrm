-- Hard-link CRM deals to BidBoard projects created from SyncHub RFP approvals.
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
      EXECUTE format('ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS procore_company_id text', tenant_schema);
      EXECUTE format('ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS bid_board_linked_at timestamptz', tenant_schema);
    END IF;
  END LOOP;
END $$;

-- TENANT_SCHEMA_START
DO $tenant$
BEGIN
  IF to_regclass('deals') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE deals ADD COLUMN IF NOT EXISTS procore_company_id text;
  ALTER TABLE deals ADD COLUMN IF NOT EXISTS bid_board_linked_at timestamptz;
END
$tenant$;
-- TENANT_SCHEMA_END
