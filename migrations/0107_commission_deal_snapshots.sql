-- Track G2: persisted per-deal commission snapshots for the sales-rep commissions page.
-- The page compares the current computed commission against the last viewed snapshot
-- to show persisted "+/- since last update" deltas.

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
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.commission_deal_snapshots (
           deal_id uuid PRIMARY KEY REFERENCES %I.deals(id) ON DELETE CASCADE,
           rep_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
           last_commission_amount numeric(14,2) NOT NULL DEFAULT 0,
           last_computed_at timestamptz NOT NULL DEFAULT now()
         )',
        tenant_schema,
        tenant_schema
      );

      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS commission_deal_snapshots_rep_idx
           ON %I.commission_deal_snapshots(rep_user_id, last_computed_at DESC)',
        tenant_schema
      );
    END IF;
  END LOOP;
END $$;

-- TENANT_SCHEMA_START
DO $tenant$
BEGIN
  IF to_regclass('deals') IS NULL THEN
    RETURN;
  END IF;

  CREATE TABLE IF NOT EXISTS commission_deal_snapshots (
    deal_id uuid PRIMARY KEY REFERENCES deals(id) ON DELETE CASCADE,
    rep_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    last_commission_amount numeric(14,2) NOT NULL DEFAULT 0,
    last_computed_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS commission_deal_snapshots_rep_idx
    ON commission_deal_snapshots(rep_user_id, last_computed_at DESC);
END
$tenant$;
-- TENANT_SCHEMA_END
