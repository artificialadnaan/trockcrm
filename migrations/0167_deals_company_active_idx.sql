-- Migration 0167: partial index on deals(company_id) WHERE is_active = TRUE.
--
-- Lane 2 (companies sortable aggregates) folds the 4 directory aggregates — Properties / Contacts /
-- Active deals / Pipeline$ — into listCompanies via a per-relation pre-aggregated LEFT JOIN derived
-- table per relation. The deals derived table GROUP-BY-company_id'es every ACTIVE deal each request so
-- those columns can be SORTED over the full filtered set. This partial index backs that grouping (and the
-- correlated `hasActivePipeline` drill / summary-card pipeline subquery) keyed on company_id over only the
-- active deals — the exact predicate the query uses — and stays small (active deals only).
--
-- contacts(company_id) and properties(company_id) FK indexes already exist (raw migrations 0019 / 0025),
-- so only the deals index is added here.
--
-- Source of truth: shared/src/schema/tenant/deals.ts declares the matching index() entry. Per-office: the
-- DO-loop applies it to every tenant schema that has a deals table. CREATE INDEX CONCURRENTLY is impossible
-- inside a DO block / transaction, so plain CREATE INDEX IF NOT EXISTS is used (sub-second at ~1.5K rows).

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
      'CREATE INDEX IF NOT EXISTS deals_company_active_idx ON %I.deals (company_id) WHERE is_active = TRUE',
      tenant_schema
    );
  END LOOP;
END $mig$;
