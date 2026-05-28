-- Adds the HubSpot raw-properties JSON blob used by Won-period reporting.
-- The hs_closed_won_date key is read via raw SQL helpers; no backfill is done.

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
      'ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS hubspot_extra_properties jsonb',
      tenant_schema
    );
  END LOOP;
END
$tenant$;

-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.deals
  ADD COLUMN IF NOT EXISTS hubspot_extra_properties jsonb;
-- TENANT_SCHEMA_END
