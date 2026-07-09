-- Migration 0179: deals.billing_contact_id (the contact who gets billed for the project). Nullable;
-- the "required to reach Won" rule is enforced in app logic, not the DB. Partial index on NULL powers the
-- future "deals missing billing" query.

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
          ADD COLUMN IF NOT EXISTS billing_contact_id uuid REFERENCES %1$I.contacts(id) ON DELETE SET NULL;

        CREATE INDEX IF NOT EXISTS deals_billing_contact_missing_idx
          ON %1$I.deals (id) WHERE billing_contact_id IS NULL;
      $sql$,
      schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema).
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.deals
  ADD COLUMN IF NOT EXISTS billing_contact_id uuid REFERENCES office_dallas.contacts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS deals_billing_contact_missing_idx
  ON office_dallas.deals (id) WHERE billing_contact_id IS NULL;
-- TENANT_SCHEMA_END
