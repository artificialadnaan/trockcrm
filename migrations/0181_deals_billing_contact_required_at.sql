-- Migration 0181: forward-only billing attention. Existing deals are deliberately not backfilled;
-- only normal projects created after this release receive billing_contact_required_at in app code.

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
          ADD COLUMN IF NOT EXISTS billing_contact_required_at timestamptz;
      $sql$,
      schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema).
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.deals
  ADD COLUMN IF NOT EXISTS billing_contact_required_at timestamptz;
-- TENANT_SCHEMA_END
