-- Redesign A2: Tier 2 schema for deal estimates, lead office, project numbers,
-- email/file junctions, file stars, and per-deal contact roles.
-- Idempotent for already-provisioned tenant schemas and replayable for future tenant schemas.

DO $$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT nspname
      FROM pg_namespace
     WHERE nspname LIKE 'office\_%' ESCAPE '\'
  LOOP
    IF to_regclass(format('%I.leads', tenant_schema)) IS NULL THEN
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = tenant_schema
         AND t.typname = 'lead_office'
    ) THEN
      EXECUTE format(
        'CREATE TYPE %I.lead_office AS ENUM (%L, %L)',
        tenant_schema,
        'dfw',
        'atl'
      );
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = tenant_schema
         AND t.typname = 'deal_contact_role'
    ) THEN
      EXECUTE format(
        'CREATE TYPE %I.deal_contact_role AS ENUM (%L, %L)',
        tenant_schema,
        'primary',
        'secondary'
      );
    END IF;

    EXECUTE format('ALTER TABLE %I.leads ADD COLUMN IF NOT EXISTS office %I.lead_office', tenant_schema, tenant_schema);
    EXECUTE format(
      'UPDATE %I.leads
          SET office = CASE
            WHEN lower(COALESCE(office_code, '''')) IN (''atl'', ''atlanta'') THEN ''atl''::%I.lead_office
            ELSE ''dfw''::%I.lead_office
          END
        WHERE office IS NULL',
      tenant_schema,
      tenant_schema,
      tenant_schema
    );
    EXECUTE format('ALTER TABLE %I.leads ALTER COLUMN office SET NOT NULL', tenant_schema);

    EXECUTE format(
      'CREATE OR REPLACE FUNCTION %I.prevent_leads_office_update()
       RETURNS trigger
       LANGUAGE plpgsql
       SET search_path = pg_catalog, public
       AS $fn$
       BEGIN
         IF OLD.office IS NOT NULL AND NEW.office IS DISTINCT FROM OLD.office THEN
           RAISE EXCEPTION ''office cannot be changed once set'';
         END IF;
         IF OLD.office_code IS NOT NULL AND NEW.office_code IS DISTINCT FROM OLD.office_code THEN
           RAISE EXCEPTION ''office_code cannot be changed once set'';
         END IF;

         RETURN NEW;
       END
       $fn$',
      tenant_schema
    );
    EXECUTE format('DROP TRIGGER IF EXISTS leads_office_immutable ON %I.leads', tenant_schema);
    EXECUTE format(
      'CREATE TRIGGER leads_office_immutable
       BEFORE UPDATE OF office, office_code ON %I.leads
       FOR EACH ROW
       EXECUTE FUNCTION %I.prevent_leads_office_update()',
      tenant_schema,
      tenant_schema
    );

    IF to_regclass(format('%I.deals', tenant_schema)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS project_number text', tenant_schema);
      EXECUTE format(
        'CREATE UNIQUE INDEX IF NOT EXISTS deals_project_number_uidx
           ON %I.deals (project_number)
         WHERE project_number IS NOT NULL',
        tenant_schema
      );

      EXECUTE format(
        'CREATE OR REPLACE FUNCTION %I.generate_project_number_placeholder(office %I.lead_office, lead_id uuid)
         RETURNS text
         LANGUAGE plpgsql
         SET search_path = pg_catalog, public
         AS $fn$
         BEGIN
           -- TODO: format spec pending from product owner.
           RETURN NULL;
         END
         $fn$',
        tenant_schema,
        tenant_schema
      );

      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.deal_contacts (
           id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
           deal_id UUID NOT NULL REFERENCES %I.deals(id) ON DELETE CASCADE,
           contact_id UUID NOT NULL REFERENCES %I.contacts(id) ON DELETE CASCADE,
           role_on_deal %I.deal_contact_role NOT NULL,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           UNIQUE (deal_id, contact_id)
         )',
        tenant_schema,
        tenant_schema,
        tenant_schema,
        tenant_schema
      );
      EXECUTE format('CREATE INDEX IF NOT EXISTS deal_contacts_deal_idx ON %I.deal_contacts (deal_id, role_on_deal)', tenant_schema);
      EXECUTE format('CREATE INDEX IF NOT EXISTS deal_contacts_contact_idx ON %I.deal_contacts (contact_id)', tenant_schema);
      EXECUTE format(
        'INSERT INTO %I.deal_contacts (deal_id, contact_id, role_on_deal)
         SELECT id, primary_contact_id, ''primary''::%I.deal_contact_role
           FROM %I.deals
          WHERE primary_contact_id IS NOT NULL
         ON CONFLICT (deal_id, contact_id) DO NOTHING',
        tenant_schema,
        tenant_schema,
        tenant_schema
      );

      IF to_regclass(format('%I.contact_deal_associations', tenant_schema)) IS NOT NULL THEN
        EXECUTE format(
          'WITH ranked AS (
             SELECT cda.deal_id,
                    cda.contact_id,
                    cda.is_primary,
                    row_number() OVER (
                      PARTITION BY cda.deal_id
                      ORDER BY cda.is_primary DESC, cda.created_at ASC, cda.id ASC
                    ) AS primary_rank
               FROM %I.contact_deal_associations cda
           )
           INSERT INTO %I.deal_contacts (deal_id, contact_id, role_on_deal)
           SELECT ranked.deal_id,
                  ranked.contact_id,
                  CASE
                    WHEN ranked.is_primary
                     AND ranked.primary_rank = 1
                     AND existing_primary.id IS NULL
                    THEN ''primary''
                    ELSE ''secondary''
                  END::%I.deal_contact_role
             FROM ranked
             LEFT JOIN %I.deal_contacts existing_primary
               ON existing_primary.deal_id = ranked.deal_id
              AND existing_primary.role_on_deal = ''primary''
           ON CONFLICT (deal_id, contact_id) DO NOTHING',
          tenant_schema,
          tenant_schema,
          tenant_schema,
          tenant_schema
        );
      END IF;

      IF to_regclass(format('%I.estimate_line_items', tenant_schema)) IS NOT NULL THEN
        EXECUTE format(
          'ALTER TABLE %I.estimate_line_items
             ADD COLUMN IF NOT EXISTS deal_id UUID,
             ADD COLUMN IF NOT EXISTS label text,
             ADD COLUMN IF NOT EXISTS qty numeric(12, 2),
             ADD COLUMN IF NOT EXISTS rate numeric(12, 2),
             ADD COLUMN IF NOT EXISTS total numeric(14, 2),
             ADD COLUMN IF NOT EXISTS sort_order integer',
          tenant_schema
        );

        IF NOT EXISTS (
          SELECT 1
            FROM pg_constraint
           WHERE conname = 'estimate_line_items_deal_id_fkey'
             AND conrelid = format('%I.estimate_line_items', tenant_schema)::regclass
        ) THEN
          EXECUTE format(
            'ALTER TABLE %I.estimate_line_items
               ADD CONSTRAINT estimate_line_items_deal_id_fkey
               FOREIGN KEY (deal_id) REFERENCES %I.deals(id) ON DELETE CASCADE',
            tenant_schema,
            tenant_schema
          );
        END IF;

        IF to_regclass(format('%I.estimate_sections', tenant_schema)) IS NOT NULL THEN
          EXECUTE format(
            'UPDATE %I.estimate_line_items eli
                SET deal_id = COALESCE(eli.deal_id, es.deal_id),
                    label = COALESCE(eli.label, eli.description),
                    qty = round(eli.quantity, 2),
                    rate = eli.unit_price,
                    total = eli.total_price,
                    sort_order = eli.display_order
               FROM %I.estimate_sections es
              WHERE eli.section_id = es.id
                AND eli.qty IS NULL',
            tenant_schema,
            tenant_schema
          );
        END IF;

        EXECUTE format(
          'ALTER TABLE %I.estimate_line_items
             ALTER COLUMN qty SET DEFAULT 1,
             ALTER COLUMN rate SET DEFAULT 0,
             ALTER COLUMN total SET DEFAULT 0,
             ALTER COLUMN sort_order SET DEFAULT 0',
          tenant_schema
        );

        EXECUTE format('CREATE INDEX IF NOT EXISTS estimate_line_items_deal_sort_idx ON %I.estimate_line_items (deal_id, sort_order, created_at)', tenant_schema);
      END IF;
    END IF;

    IF to_regclass(format('%I.emails', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I.emails
           ADD COLUMN IF NOT EXISTS ai_suggestions jsonb NOT NULL DEFAULT ''[]''::jsonb',
        tenant_schema
      );

      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.email_links (
           id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
           email_id UUID NOT NULL REFERENCES %I.emails(id) ON DELETE CASCADE,
           entity_type text NOT NULL CHECK (entity_type IN (''deal'', ''lead'', ''contact'', ''company'', ''property'')),
           entity_id UUID NOT NULL,
           confidence numeric(3, 2),
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
           UNIQUE (email_id, entity_type, entity_id)
         )',
        tenant_schema,
        tenant_schema
      );
      EXECUTE format('CREATE INDEX IF NOT EXISTS email_links_email_idx ON %I.email_links (email_id)', tenant_schema);
      EXECUTE format('CREATE INDEX IF NOT EXISTS email_links_entity_idx ON %I.email_links (entity_type, entity_id)', tenant_schema);
      EXECUTE format(
        'INSERT INTO %I.email_links (email_id, entity_type, entity_id, confidence)
         SELECT id,
                assigned_entity_type,
                assigned_entity_id,
                CASE WHEN assignment_confidence = ''high'' THEN 1.00::numeric(3, 2) ELSE 0.50::numeric(3, 2) END
           FROM %I.emails
          WHERE assigned_entity_type IN (''deal'', ''lead'', ''contact'', ''company'', ''property'')
            AND assigned_entity_id IS NOT NULL
         ON CONFLICT (email_id, entity_type, entity_id) DO NOTHING',
        tenant_schema,
        tenant_schema
      );
    END IF;

    IF to_regclass(format('%I.files', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.file_links (
           id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
           file_id UUID NOT NULL REFERENCES %I.files(id) ON DELETE CASCADE,
           entity_type text NOT NULL CHECK (entity_type IN (''deal'', ''lead'', ''contact'', ''company'', ''property'')),
           entity_id UUID NOT NULL,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
           UNIQUE (file_id, entity_type, entity_id)
         )',
        tenant_schema,
        tenant_schema
      );
      EXECUTE format('CREATE INDEX IF NOT EXISTS file_links_file_idx ON %I.file_links (file_id)', tenant_schema);
      EXECUTE format('CREATE INDEX IF NOT EXISTS file_links_entity_idx ON %I.file_links (entity_type, entity_id)', tenant_schema);

      EXECUTE format(
        'INSERT INTO %I.file_links (file_id, entity_type, entity_id)
         SELECT id, ''deal'', deal_id
           FROM %I.files
          WHERE deal_id IS NOT NULL
         ON CONFLICT (file_id, entity_type, entity_id) DO NOTHING',
        tenant_schema,
        tenant_schema
      );
      EXECUTE format(
        'INSERT INTO %I.file_links (file_id, entity_type, entity_id)
         SELECT id, ''lead'', lead_id
           FROM %I.files
          WHERE lead_id IS NOT NULL
         ON CONFLICT (file_id, entity_type, entity_id) DO NOTHING',
        tenant_schema,
        tenant_schema
      );
      EXECUTE format(
        'INSERT INTO %I.file_links (file_id, entity_type, entity_id)
         SELECT id, ''contact'', contact_id
           FROM %I.files
          WHERE contact_id IS NOT NULL
         ON CONFLICT (file_id, entity_type, entity_id) DO NOTHING',
        tenant_schema,
        tenant_schema
      );

      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.user_starred_files (
           user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
           file_id UUID NOT NULL REFERENCES %I.files(id) ON DELETE CASCADE,
           starred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           PRIMARY KEY (user_id, file_id)
         )',
        tenant_schema,
        tenant_schema
      );
      EXECUTE format('CREATE INDEX IF NOT EXISTS user_starred_files_file_idx ON %I.user_starred_files (file_id)', tenant_schema);
    END IF;
  END LOOP;
END $$;

-- TENANT_SCHEMA_START
DO $tenant$
BEGIN
  IF to_regclass('leads') IS NULL THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_type
     WHERE typname = 'lead_office'
       AND typnamespace = current_schema()::regnamespace
  ) THEN
    CREATE TYPE lead_office AS ENUM ('dfw', 'atl');
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_type
     WHERE typname = 'deal_contact_role'
       AND typnamespace = current_schema()::regnamespace
  ) THEN
    CREATE TYPE deal_contact_role AS ENUM ('primary', 'secondary');
  END IF;

  ALTER TABLE leads ADD COLUMN IF NOT EXISTS office lead_office;

  UPDATE leads
     SET office = CASE
       WHEN lower(COALESCE(office_code, '')) IN ('atl', 'atlanta') THEN 'atl'::lead_office
       ELSE 'dfw'::lead_office
     END
   WHERE office IS NULL;

  ALTER TABLE leads ALTER COLUMN office SET NOT NULL;

  CREATE OR REPLACE FUNCTION prevent_leads_office_update()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $fn$
  BEGIN
    IF OLD.office IS NOT NULL AND NEW.office IS DISTINCT FROM OLD.office THEN
      RAISE EXCEPTION 'office cannot be changed once set';
    END IF;
    IF OLD.office_code IS NOT NULL AND NEW.office_code IS DISTINCT FROM OLD.office_code THEN
      RAISE EXCEPTION 'office_code cannot be changed once set';
    END IF;

    RETURN NEW;
  END
  $fn$;

  DROP TRIGGER IF EXISTS leads_office_immutable ON leads;
  CREATE TRIGGER leads_office_immutable
    BEFORE UPDATE OF office, office_code ON leads
    FOR EACH ROW
    EXECUTE FUNCTION prevent_leads_office_update();

  IF to_regclass('deals') IS NOT NULL THEN
    ALTER TABLE deals ADD COLUMN IF NOT EXISTS project_number text;
    CREATE UNIQUE INDEX IF NOT EXISTS deals_project_number_uidx
      ON deals (project_number)
      WHERE project_number IS NOT NULL;

    CREATE OR REPLACE FUNCTION generate_project_number_placeholder(office lead_office, lead_id uuid)
    RETURNS text
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $fn$
    BEGIN
      -- TODO: format spec pending from product owner.
      RETURN NULL;
    END
    $fn$;

    CREATE TABLE IF NOT EXISTS deal_contacts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
      contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      role_on_deal deal_contact_role NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (deal_id, contact_id)
    );
    CREATE INDEX IF NOT EXISTS deal_contacts_deal_idx ON deal_contacts (deal_id, role_on_deal);
    CREATE INDEX IF NOT EXISTS deal_contacts_contact_idx ON deal_contacts (contact_id);

    INSERT INTO deal_contacts (deal_id, contact_id, role_on_deal)
    SELECT id, primary_contact_id, 'primary'::deal_contact_role
      FROM deals
     WHERE primary_contact_id IS NOT NULL
    ON CONFLICT (deal_id, contact_id) DO NOTHING;

    IF to_regclass('contact_deal_associations') IS NOT NULL THEN
      WITH ranked AS (
        SELECT cda.deal_id,
               cda.contact_id,
               cda.is_primary,
               row_number() OVER (
                 PARTITION BY cda.deal_id
                 ORDER BY cda.is_primary DESC, cda.created_at ASC, cda.id ASC
           ) AS primary_rank
          FROM contact_deal_associations cda
      )
      INSERT INTO deal_contacts (deal_id, contact_id, role_on_deal)
      SELECT ranked.deal_id,
             ranked.contact_id,
             CASE
               WHEN ranked.is_primary
                AND ranked.primary_rank = 1
                AND existing_primary.id IS NULL
               THEN 'primary'
               ELSE 'secondary'
             END::deal_contact_role
        FROM ranked
        LEFT JOIN deal_contacts existing_primary
          ON existing_primary.deal_id = ranked.deal_id
         AND existing_primary.role_on_deal = 'primary'
      ON CONFLICT (deal_id, contact_id) DO NOTHING;
    END IF;

    IF to_regclass('estimate_line_items') IS NOT NULL THEN
      ALTER TABLE estimate_line_items
        ADD COLUMN IF NOT EXISTS deal_id UUID,
        ADD COLUMN IF NOT EXISTS label text,
        ADD COLUMN IF NOT EXISTS qty numeric(12, 2),
        ADD COLUMN IF NOT EXISTS rate numeric(12, 2),
        ADD COLUMN IF NOT EXISTS total numeric(14, 2),
        ADD COLUMN IF NOT EXISTS sort_order integer;

      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'estimate_line_items_deal_id_fkey'
           AND conrelid = 'estimate_line_items'::regclass
      ) THEN
        ALTER TABLE estimate_line_items
          ADD CONSTRAINT estimate_line_items_deal_id_fkey
          FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE;
      END IF;

      IF to_regclass('estimate_sections') IS NOT NULL THEN
        UPDATE estimate_line_items eli
           SET deal_id = COALESCE(eli.deal_id, es.deal_id),
               label = COALESCE(eli.label, eli.description),
               qty = round(eli.quantity, 2),
               rate = eli.unit_price,
               total = eli.total_price,
               sort_order = eli.display_order
          FROM estimate_sections es
         WHERE eli.section_id = es.id
           AND eli.qty IS NULL;
      END IF;

      ALTER TABLE estimate_line_items
        ALTER COLUMN qty SET DEFAULT 1,
        ALTER COLUMN rate SET DEFAULT 0,
        ALTER COLUMN total SET DEFAULT 0,
        ALTER COLUMN sort_order SET DEFAULT 0;

      CREATE INDEX IF NOT EXISTS estimate_line_items_deal_sort_idx
        ON estimate_line_items (deal_id, sort_order, created_at);
    END IF;
  END IF;

  IF to_regclass('emails') IS NOT NULL THEN
    ALTER TABLE emails
      ADD COLUMN IF NOT EXISTS ai_suggestions jsonb NOT NULL DEFAULT '[]'::jsonb;

    CREATE TABLE IF NOT EXISTS email_links (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email_id UUID NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
      entity_type text NOT NULL CHECK (entity_type IN ('deal', 'lead', 'contact', 'company', 'property')),
      entity_id UUID NOT NULL,
      confidence numeric(3, 2),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
      UNIQUE (email_id, entity_type, entity_id)
    );
    CREATE INDEX IF NOT EXISTS email_links_email_idx ON email_links (email_id);
    CREATE INDEX IF NOT EXISTS email_links_entity_idx ON email_links (entity_type, entity_id);

    INSERT INTO email_links (email_id, entity_type, entity_id, confidence)
    SELECT id,
           assigned_entity_type,
           assigned_entity_id,
           CASE WHEN assignment_confidence = 'high' THEN 1.00::numeric(3, 2) ELSE 0.50::numeric(3, 2) END
      FROM emails
     WHERE assigned_entity_type IN ('deal', 'lead', 'contact', 'company', 'property')
       AND assigned_entity_id IS NOT NULL
    ON CONFLICT (email_id, entity_type, entity_id) DO NOTHING;
  END IF;

  IF to_regclass('files') IS NOT NULL THEN
    CREATE TABLE IF NOT EXISTS file_links (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      entity_type text NOT NULL CHECK (entity_type IN ('deal', 'lead', 'contact', 'company', 'property')),
      entity_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
      UNIQUE (file_id, entity_type, entity_id)
    );
    CREATE INDEX IF NOT EXISTS file_links_file_idx ON file_links (file_id);
    CREATE INDEX IF NOT EXISTS file_links_entity_idx ON file_links (entity_type, entity_id);

    INSERT INTO file_links (file_id, entity_type, entity_id)
    SELECT id, 'deal', deal_id FROM files WHERE deal_id IS NOT NULL
    ON CONFLICT (file_id, entity_type, entity_id) DO NOTHING;

    INSERT INTO file_links (file_id, entity_type, entity_id)
    SELECT id, 'lead', lead_id FROM files WHERE lead_id IS NOT NULL
    ON CONFLICT (file_id, entity_type, entity_id) DO NOTHING;

    INSERT INTO file_links (file_id, entity_type, entity_id)
    SELECT id, 'contact', contact_id FROM files WHERE contact_id IS NOT NULL
    ON CONFLICT (file_id, entity_type, entity_id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS user_starred_files (
      user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      starred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, file_id)
    );
    CREATE INDEX IF NOT EXISTS user_starred_files_file_idx ON user_starred_files (file_id);
  END IF;
END
$tenant$;
-- TENANT_SCHEMA_END
