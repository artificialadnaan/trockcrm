-- Tier A project value display for the forward-looking Procore Portfolio board.
-- Adds SyncHub-sourced total_value and its source freshness timestamp to the
-- relay-driven portfolio_projects table. The legacy projects table is untouched.

DO $tenant$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT nspname
      FROM pg_namespace
     WHERE nspname LIKE 'office\_%' ESCAPE '\'
     ORDER BY nspname
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.portfolio_projects ADD COLUMN IF NOT EXISTS total_value numeric(14,2)',
      tenant_schema
    );
    EXECUTE format(
      'ALTER TABLE %I.portfolio_projects ADD COLUMN IF NOT EXISTS value_synced_at timestamptz',
      tenant_schema
    );
  END LOOP;
END
$tenant$;

-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.portfolio_projects
  ADD COLUMN IF NOT EXISTS total_value numeric(14,2);

ALTER TABLE office_dallas.portfolio_projects
  ADD COLUMN IF NOT EXISTS value_synced_at timestamptz;
-- TENANT_SCHEMA_END
