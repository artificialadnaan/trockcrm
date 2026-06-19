-- Migration 0168: partial index on deals(property_id) WHERE is_active for the Properties Linked Value fold.
--
-- listProperties now LEFT JOINs a per-property aggregate of active linked deal value
-- (COALESCE(SUM(effective deal value)), grouped by property_id, WHERE is_active = TRUE) so the directory
-- can FILTER (min/max range) and SORT on Linked Value over the FULL filtered set before LIMIT. This
-- partial index backs that GROUP BY / join key and keeps the hash-aggregate input small (active deals
-- only), matching the query predicate exactly.
--
-- Per-office (one schema per office). Plain CREATE INDEX IF NOT EXISTS — a concurrent (non-blocking)
-- index build is impossible inside a DO block/txn, and the tenant deals tables are small (single-office
-- ~5K-8K rows), so the plain build is sub-second and safe. Auto-runs on deploy (the API Dockerfile runs the
-- migration runner before app start; new NNNN_*.sql applied in alpha order, tracked in public._migrations).
-- Source-of-truth mirror: index("deals_property_active_idx") in shared/src/schema/tenant/deals.ts.

DO $mig$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name NOT IN ('public', 'information_schema', 'pg_catalog', 'migration')
      AND schema_name NOT LIKE 'pg_%'
  LOOP
    IF to_regclass(format('%I.deals', tenant_schema)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS deals_property_active_idx ON %I.deals (property_id) WHERE is_active = TRUE',
      tenant_schema
    );
  END LOOP;
END $mig$;

-- New tenants: cloned by the office provisioner (provisionOfficeSchema replays only marker blocks,
-- office_dallas -> the new schema). Runs idempotently for office_dallas at migration time too
-- (redundant with the DO-loop above, guarded by IF NOT EXISTS) so offices created after this deploy
-- still get the partial index.
-- TENANT_SCHEMA_START
CREATE INDEX IF NOT EXISTS deals_property_active_idx ON office_dallas.deals (property_id) WHERE is_active = TRUE;
-- TENANT_SCHEMA_END
