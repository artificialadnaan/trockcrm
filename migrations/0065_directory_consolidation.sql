DO $$ BEGIN
  CREATE TYPE directory_entity_type AS ENUM ('company', 'contact');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE directory_merge_status AS ENUM ('pending', 'auto_merged', 'merged', 'dismissed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname LIKE 'office\_%' ESCAPE '\'
  LOOP
    IF to_regclass(format('%I.companies', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I.companies
           ADD COLUMN IF NOT EXISTS source_refs jsonb NOT NULL DEFAULT ''{}''::jsonb',
        tenant_schema
      );
    END IF;

    IF to_regclass(format('%I.contacts', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I.contacts
           ADD COLUMN IF NOT EXISTS source_refs jsonb NOT NULL DEFAULT ''{}''::jsonb',
        tenant_schema
      );
    END IF;

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.directory_merge_queue (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         entity_type directory_entity_type NOT NULL,
         entity_a_id uuid NOT NULL,
         entity_b_id uuid NOT NULL,
         confidence_score numeric(4,3) NOT NULL,
         match_reasons jsonb NOT NULL DEFAULT ''[]''::jsonb,
         status directory_merge_status NOT NULL DEFAULT ''pending'',
         resolved_by uuid REFERENCES public.users(id),
         resolved_at timestamptz,
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now()
       )',
      tenant_schema
    );

    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS directory_merge_queue_pair_uidx
         ON %I.directory_merge_queue (entity_type, entity_a_id, entity_b_id)',
      tenant_schema
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS directory_merge_queue_status_idx
         ON %I.directory_merge_queue (status, entity_type)',
      tenant_schema
    );

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.directory_merge_audit (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         queue_entry_id uuid,
         entity_type directory_entity_type NOT NULL,
         winner_id uuid NOT NULL,
         loser_id uuid NOT NULL,
         confidence_score numeric(4,3) NOT NULL,
         match_reasons jsonb NOT NULL DEFAULT ''[]''::jsonb,
         mode varchar(32) NOT NULL,
         merged_by uuid REFERENCES public.users(id),
         field_changes jsonb NOT NULL DEFAULT ''{}''::jsonb,
         created_at timestamptz NOT NULL DEFAULT now()
       )',
      tenant_schema
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS directory_merge_audit_entity_idx
         ON %I.directory_merge_audit (entity_type, created_at)',
      tenant_schema
    );
  END LOOP;
END $$;
