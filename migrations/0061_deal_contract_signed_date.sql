-- Migration 0061: contract_signed_date on per-tenant deals tables
-- Additive only. Nullable date column. The set/clear path is gated by RBAC
-- (admin / director only) at the API layer; the column itself imposes no
-- constraint. Commission calculation hooks the null→date transition in a
-- subsequent migration/code (Commit 6 of the 2026-04-27 batch).

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
        'ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS contract_signed_date date',
        tenant_schema
      );
    END IF;
  END LOOP;
END $$;
