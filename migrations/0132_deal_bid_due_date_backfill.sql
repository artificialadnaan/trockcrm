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
    IF to_regclass(format('%I.deals', tenant_schema)) IS NULL
       OR to_regclass(format('%I.leads', tenant_schema)) IS NULL THEN
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = tenant_schema
        AND table_name = 'deals'
        AND column_name = 'bid_due_date'
    ) OR NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = tenant_schema
        AND table_name = 'deals'
        AND column_name = 'source_lead_id'
    ) OR NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = tenant_schema
        AND table_name = 'leads'
        AND column_name = 'bid_due_date'
    ) THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      $sql$
        UPDATE %I.deals d
           SET bid_due_date = (l.bid_due_date::text || 'T00:00:00.000Z')::timestamptz
          FROM %I.leads l
         WHERE l.id = d.source_lead_id
           AND d.source_lead_id IS NOT NULL
           AND d.bid_due_date IS NULL
           AND l.bid_due_date IS NOT NULL;
      $sql$,
      tenant_schema,
      tenant_schema
    );
  END LOOP;
END
$tenant$;

-- TENANT_SCHEMA_START
UPDATE office_dallas.deals d
   SET bid_due_date = (l.bid_due_date::text || 'T00:00:00.000Z')::timestamptz
  FROM office_dallas.leads l
 WHERE l.id = d.source_lead_id
   AND d.source_lead_id IS NOT NULL
   AND d.bid_due_date IS NULL
   AND l.bid_due_date IS NOT NULL;
-- TENANT_SCHEMA_END
