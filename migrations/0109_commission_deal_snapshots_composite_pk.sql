-- Track G2 fix-forward: snapshot rows are scoped to the rep that saw the deal.
-- A deal can move between reps over time, so the persisted delta baseline must
-- be keyed by both deal_id and rep_user_id.

DO $$
DECLARE
  tenant_schema text;
  has_duplicate_rows boolean;
BEGIN
  FOR tenant_schema IN
    SELECT nspname
      FROM pg_namespace
     WHERE nspname LIKE 'office\_%' ESCAPE '\'
  LOOP
    IF to_regclass(format('%I.commission_deal_snapshots', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        'SELECT EXISTS (
           SELECT 1
             FROM (
               SELECT deal_id, rep_user_id, COUNT(*) AS row_count
                 FROM %I.commission_deal_snapshots
                GROUP BY deal_id, rep_user_id
               HAVING COUNT(*) > 1
             ) duplicate_snapshots
         )',
        tenant_schema
      )
      INTO has_duplicate_rows;

      IF has_duplicate_rows THEN
        RAISE EXCEPTION
          'Migration 0109 cannot replace commission_deal_snapshots primary key for schema % because duplicate deal_id/rep_user_id rows exist. Review the data before rerunning.',
          tenant_schema;
      END IF;

      EXECUTE format(
        'ALTER TABLE %I.commission_deal_snapshots
           DROP CONSTRAINT IF EXISTS commission_deal_snapshots_pkey',
        tenant_schema
      );

      EXECUTE format(
        'ALTER TABLE %I.commission_deal_snapshots
           ADD CONSTRAINT commission_deal_snapshots_pkey PRIMARY KEY (deal_id, rep_user_id)',
        tenant_schema
      );
    END IF;
  END LOOP;
END $$;

-- TENANT_SCHEMA_START
DO $tenant$
DECLARE
  has_duplicate_rows boolean;
BEGIN
  IF to_regclass('commission_deal_snapshots') IS NULL THEN
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM (
        SELECT deal_id, rep_user_id, COUNT(*) AS row_count
          FROM commission_deal_snapshots
         GROUP BY deal_id, rep_user_id
        HAVING COUNT(*) > 1
      ) duplicate_snapshots
  )
  INTO has_duplicate_rows;

  IF has_duplicate_rows THEN
    RAISE EXCEPTION
      'Migration 0109 cannot replace commission_deal_snapshots primary key because duplicate deal_id/rep_user_id rows exist. Review the data before rerunning.';
  END IF;

  ALTER TABLE commission_deal_snapshots
    DROP CONSTRAINT IF EXISTS commission_deal_snapshots_pkey;

  ALTER TABLE commission_deal_snapshots
    ADD CONSTRAINT commission_deal_snapshots_pkey PRIMARY KEY (deal_id, rep_user_id);
END
$tenant$;
-- TENANT_SCHEMA_END
