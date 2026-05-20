-- Migration 0130: remove the obsolete files_association_check constraint.
-- PR #399 introduced targetless/pending field photo uploads, which intentionally
-- create file records before a deal/lead/opportunity is chosen. The historical
-- files_association_check constraint rejects fully unassigned rows, so it no
-- longer reflects valid application behavior. Drop it across all tenant schemas
-- instead of replacing it with a tautological no-op constraint.

DO $$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name NOT IN ('public', 'information_schema', 'pg_catalog')
      AND schema_name NOT LIKE 'pg_%'
  LOOP
    IF to_regclass(format('%I.files', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %1$I.files
           DROP CONSTRAINT IF EXISTS files_association_check',
        tenant_schema
      );
    END IF;
  END LOOP;
END $$;
