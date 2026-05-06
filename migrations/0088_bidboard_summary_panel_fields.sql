-- Fields used by the CRM deal-page Bid Board summary panel.
-- bid_board_last_updated_at is populated from the Bid Board export cycle timestamp.
-- bid_board_assigned_pm is reserved for Procore role polling after portfolio handoff.

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
      EXECUTE format('ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS bid_board_last_updated_at timestamptz', tenant_schema);
      EXECUTE format('ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS bid_board_assigned_pm text', tenant_schema);
    END IF;
  END LOOP;
END $$;

-- TENANT_SCHEMA_START
DO $tenant$
BEGIN
  IF to_regclass('deals') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE deals ADD COLUMN IF NOT EXISTS bid_board_last_updated_at timestamptz;
  ALTER TABLE deals ADD COLUMN IF NOT EXISTS bid_board_assigned_pm text;
END
$tenant$;
-- TENANT_SCHEMA_END
