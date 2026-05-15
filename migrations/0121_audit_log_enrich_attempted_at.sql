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
      $sql$
        ALTER TABLE %I.audit_log
          ADD COLUMN IF NOT EXISTS enrich_attempted_at timestamptz;
      $sql$,
      tenant_schema
    );
    EXECUTE format(
      $sql$
        CREATE INDEX IF NOT EXISTS audit_log_enrich_attempted_at_idx
          ON %I.audit_log (enrich_attempted_at)
          WHERE enrich_attempted_at IS NULL;
      $sql$,
      tenant_schema
    );
  END LOOP;
END
$tenant$;

-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.audit_log
  ADD COLUMN IF NOT EXISTS enrich_attempted_at timestamptz;

CREATE INDEX IF NOT EXISTS audit_log_enrich_attempted_at_idx
  ON office_dallas.audit_log (enrich_attempted_at)
  WHERE enrich_attempted_at IS NULL;
-- TENANT_SCHEMA_END
