-- Migration 0175: deals.sales_source_user_id (the capX rep who SOURCED a service opportunity).
--
-- Set once at service-opportunity creation, locked afterward (admin/director override only). Nullable
-- FK to public.users, ON DELETE SET NULL (FK-safety guard, matching estimator_user_id / migration 0150).
-- Drives the additive attribution_role='sales_source' commission row + the floor-gate sales-source
-- qualifying leg (PR2). deals is a per-tenant office_* table, so this loops existing tenants (with the
-- drifted-office guard) AND carries a TENANT_SCHEMA block so the office provisioner clones it to new
-- schemas. Partial index mirrors deals_estimator_user_id_idx.

DO $tenant$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\_%' ESCAPE '\' ORDER BY nspname
  LOOP
    IF to_regclass(format('%I.deals', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      $sql$
        ALTER TABLE %1$I.deals
          ADD COLUMN IF NOT EXISTS sales_source_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL;

        CREATE INDEX IF NOT EXISTS deals_sales_source_user_id_idx
          ON %1$I.deals (sales_source_user_id) WHERE sales_source_user_id IS NOT NULL;
      $sql$,
      schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema). Runs idempotently for
-- office_dallas at migration time too (redundant with the DO-loop above, guarded by IF NOT EXISTS).
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.deals
  ADD COLUMN IF NOT EXISTS sales_source_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS deals_sales_source_user_id_idx
  ON office_dallas.deals (sales_source_user_id) WHERE sales_source_user_id IS NOT NULL;
-- TENANT_SCHEMA_END
