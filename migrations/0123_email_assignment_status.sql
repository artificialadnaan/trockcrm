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
    IF to_regclass(format('%I.emails', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        $sql$
          ALTER TABLE %I.emails
            ADD COLUMN IF NOT EXISTS assignment_status varchar(20) NOT NULL DEFAULT 'unassigned';
        $sql$,
        tenant_schema
      );

      EXECUTE format(
        $sql$
          UPDATE %I.emails
             SET assignment_status = 'assigned'
           WHERE assignment_status = 'unassigned'
             AND (assigned_entity_id IS NOT NULL OR deal_id IS NOT NULL);
        $sql$,
        tenant_schema
      );

      EXECUTE format(
        $sql$
          CREATE INDEX IF NOT EXISTS emails_assignment_status_idx
            ON %I.emails (assignment_status);
        $sql$,
        tenant_schema
      );
    END IF;
  END LOOP;
END
$tenant$;

-- TENANT_SCHEMA_START
DO $tenant_schema$
BEGIN
  IF to_regclass('emails') IS NOT NULL THEN
    ALTER TABLE emails
      ADD COLUMN IF NOT EXISTS assignment_status varchar(20) NOT NULL DEFAULT 'unassigned';

    UPDATE emails
       SET assignment_status = 'assigned'
     WHERE assignment_status = 'unassigned'
       AND (assigned_entity_id IS NOT NULL OR deal_id IS NOT NULL);

    CREATE INDEX IF NOT EXISTS emails_assignment_status_idx
      ON emails (assignment_status);
  END IF;
END
$tenant_schema$;
-- TENANT_SCHEMA_END
