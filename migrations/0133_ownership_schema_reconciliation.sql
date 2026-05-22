-- Ownership labels slice 2: reconcile Company/Contact owner columns.
-- Live Dallas data already uses owner_id for both tables; older schema work
-- added companies.owner_user_id. Consolidate safely onto owner_id everywhere.

DO $tenant$
DECLARE
  tenant_schema text;
  has_company_owner_user_id boolean;
  company_conflicts integer;
BEGIN
  FOR tenant_schema IN
    SELECT nspname
      FROM pg_namespace
     WHERE nspname LIKE 'office\_%' ESCAPE '\'
     ORDER BY nspname
  LOOP
    IF to_regclass(format('%I.companies', tenant_schema)) IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = tenant_schema
           AND table_name = 'companies'
           AND column_name = 'owner_user_id'
      )
        INTO has_company_owner_user_id;

      EXECUTE format('ALTER TABLE %I.companies ADD COLUMN IF NOT EXISTS owner_id uuid', tenant_schema);

      IF has_company_owner_user_id THEN
        EXECUTE format(
          'SELECT count(*)::int
             FROM %I.companies
            WHERE owner_id IS NOT NULL
              AND owner_user_id IS NOT NULL
              AND owner_id <> owner_user_id',
          tenant_schema
        )
        INTO company_conflicts;

        IF company_conflicts > 0 THEN
          RAISE EXCEPTION
            'Refusing to drop %.companies.owner_user_id: % rows have conflicting owner_id and owner_user_id values',
            tenant_schema,
            company_conflicts;
        END IF;

        EXECUTE format(
          'UPDATE %I.companies
              SET owner_id = owner_user_id
            WHERE owner_id IS NULL AND owner_user_id IS NOT NULL',
          tenant_schema
        );

        EXECUTE format('ALTER TABLE %I.companies DROP COLUMN IF EXISTS owner_user_id', tenant_schema);
      END IF;

      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'companies_owner_id_users_id_fk'
           AND conrelid = format('%I.companies', tenant_schema)::regclass
      ) THEN
        EXECUTE format(
          'ALTER TABLE %I.companies
             ADD CONSTRAINT companies_owner_id_users_id_fk
             FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE SET NULL',
          tenant_schema
        );
      END IF;

      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS companies_owner_id_idx
           ON %I.companies(owner_id)
         WHERE owner_id IS NOT NULL',
        tenant_schema
      );
    END IF;

    IF to_regclass(format('%I.contacts', tenant_schema)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I.contacts ADD COLUMN IF NOT EXISTS owner_id uuid', tenant_schema);

      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'contacts_owner_id_users_id_fk'
           AND conrelid = format('%I.contacts', tenant_schema)::regclass
      ) THEN
        EXECUTE format(
          'ALTER TABLE %I.contacts
             ADD CONSTRAINT contacts_owner_id_users_id_fk
             FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE SET NULL',
          tenant_schema
        );
      END IF;

      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS contacts_owner_id_idx
           ON %I.contacts(owner_id)
         WHERE owner_id IS NOT NULL',
        tenant_schema
      );
    END IF;
  END LOOP;
END
$tenant$;

-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.companies ADD COLUMN IF NOT EXISTS owner_id uuid;

DO $office_dallas_companies$
DECLARE
  has_company_owner_user_id boolean;
  company_conflicts integer;
BEGIN
  SELECT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'office_dallas'
       AND table_name = 'companies'
       AND column_name = 'owner_user_id'
  )
    INTO has_company_owner_user_id;

  IF has_company_owner_user_id THEN
    SELECT count(*)::int
      FROM office_dallas.companies
     WHERE owner_id IS NOT NULL
       AND owner_user_id IS NOT NULL
       AND owner_id <> owner_user_id
      INTO company_conflicts;

    IF company_conflicts > 0 THEN
      RAISE EXCEPTION
        'Refusing to drop office_dallas.companies.owner_user_id: % rows have conflicting owner_id and owner_user_id values',
        company_conflicts;
    END IF;

    UPDATE office_dallas.companies
       SET owner_id = owner_user_id
     WHERE owner_id IS NULL AND owner_user_id IS NOT NULL;

    ALTER TABLE office_dallas.companies DROP COLUMN IF EXISTS owner_user_id;
  END IF;
END
$office_dallas_companies$;

DO $office_dallas_company_fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'companies_owner_id_users_id_fk'
       AND conrelid = 'office_dallas.companies'::regclass
  ) THEN
    ALTER TABLE office_dallas.companies
      ADD CONSTRAINT companies_owner_id_users_id_fk
      FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END
$office_dallas_company_fk$;

CREATE INDEX IF NOT EXISTS companies_owner_id_idx
  ON office_dallas.companies(owner_id)
  WHERE owner_id IS NOT NULL;

ALTER TABLE office_dallas.contacts ADD COLUMN IF NOT EXISTS owner_id uuid;

DO $office_dallas_contact_fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'contacts_owner_id_users_id_fk'
       AND conrelid = 'office_dallas.contacts'::regclass
  ) THEN
    ALTER TABLE office_dallas.contacts
      ADD CONSTRAINT contacts_owner_id_users_id_fk
      FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END
$office_dallas_contact_fk$;

CREATE INDEX IF NOT EXISTS contacts_owner_id_idx
  ON office_dallas.contacts(owner_id)
  WHERE owner_id IS NOT NULL;
-- TENANT_SCHEMA_END
