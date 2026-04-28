-- Migration 0064: HubSpot nightly refresh audit and sync marker
--
-- Adds a per-deal timestamp for the controlled HubSpot refresh script and
-- a shared audit table for per-field refresh writes.

DO $$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name NOT IN ('public', 'information_schema', 'pg_catalog', 'migration')
      AND schema_name NOT LIKE 'pg_%'
  LOOP
    IF to_regclass(format('%I.deals', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS last_synced_from_hubspot_at TIMESTAMPTZ',
        tenant_schema
      );

      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS deals_last_synced_from_hubspot_idx ON %I.deals (last_synced_from_hubspot_at DESC) WHERE hubspot_deal_id IS NOT NULL',
        tenant_schema
      );
    END IF;
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS public.hubspot_refresh_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL,
  tenant_schema TEXT NOT NULL,
  deal_id UUID NOT NULL,
  field_name TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS hubspot_refresh_log_run_idx
  ON public.hubspot_refresh_log (run_id, tenant_schema, deal_id);

CREATE INDEX IF NOT EXISTS hubspot_refresh_log_created_idx
  ON public.hubspot_refresh_log (created_at DESC);
