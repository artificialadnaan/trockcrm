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
  END LOOP;
END
$tenant$;
