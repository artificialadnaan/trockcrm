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
      $sql$
        ALTER TABLE %I.deals
          ADD COLUMN IF NOT EXISTS on_hold boolean NOT NULL DEFAULT false,
          ADD COLUMN IF NOT EXISTS on_hold_started_at timestamptz,
          ADD COLUMN IF NOT EXISTS on_hold_accumulated_seconds bigint NOT NULL DEFAULT 0;
      $sql$,
      tenant_schema
    );
  END LOOP;
END
$tenant$;

-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.deals
  ADD COLUMN IF NOT EXISTS on_hold boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS on_hold_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS on_hold_accumulated_seconds bigint NOT NULL DEFAULT 0;
-- TENANT_SCHEMA_END
