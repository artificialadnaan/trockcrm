-- Migration 0182: deal team members can reference either an app user OR a CRM contact.
-- Adds contact_id, makes user_id nullable, and enforces exactly one of user_id / contact_id
-- via a table CHECK constraint. Idempotent across all tenant office_* schemas.

DO $tenant$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\_%' ESCAPE '\' ORDER BY nspname
  LOOP
    IF to_regclass(format('%I.deal_team_members', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      $sql$
        ALTER TABLE %1$I.deal_team_members
          ADD COLUMN IF NOT EXISTS contact_id uuid;
        ALTER TABLE %1$I.deal_team_members
          ALTER COLUMN user_id DROP NOT NULL;
      $sql$,
      schema_name
    );

    IF NOT EXISTS (
      SELECT 1
        FROM pg_constraint
       WHERE conname = 'deal_team_members_user_or_contact_check'
         AND conrelid = format('%I.deal_team_members', schema_name)::regclass
    ) THEN
      EXECUTE format(
        $sql$
          ALTER TABLE %1$I.deal_team_members
            ADD CONSTRAINT deal_team_members_user_or_contact_check
            CHECK (
              (user_id IS NOT NULL AND contact_id IS NULL)
              OR (user_id IS NULL AND contact_id IS NOT NULL)
            );
        $sql$,
        schema_name
      );
    END IF;
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema).
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.deal_team_members
  ADD COLUMN IF NOT EXISTS contact_id uuid;
ALTER TABLE office_dallas.deal_team_members
  ALTER COLUMN user_id DROP NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'deal_team_members_user_or_contact_check'
       AND conrelid = 'office_dallas.deal_team_members'::regclass
  ) THEN
    ALTER TABLE office_dallas.deal_team_members
      ADD CONSTRAINT deal_team_members_user_or_contact_check
      CHECK (
        (user_id IS NOT NULL AND contact_id IS NULL)
        OR (user_id IS NULL AND contact_id IS NOT NULL)
      );
  END IF;
END $$;
-- TENANT_SCHEMA_END
