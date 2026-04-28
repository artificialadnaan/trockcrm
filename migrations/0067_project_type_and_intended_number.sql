DO $$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname LIKE 'office\_%' ESCAPE '\'
  LOOP
    IF to_regclass(format('%I.leads', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I.leads
           ADD COLUMN IF NOT EXISTS project_type text',
        tenant_schema
      );

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'leads_project_type_allowlist_chk'
          AND conrelid = format('%I.leads', tenant_schema)::regclass
      ) THEN
        EXECUTE format(
          'ALTER TABLE %I.leads
             ADD CONSTRAINT leads_project_type_allowlist_chk
             CHECK (
               project_type IS NULL OR project_type IN (
                 ''exterior renovation'',
                 ''interior renovation'',
                 ''roofing'',
                 ''service'',
                 ''commercial'',
                 ''hospitality'',
                 ''emergency'',
                 ''development'',
                 ''residential''
               )
             )',
          tenant_schema
        );
      END IF;
    END IF;

    IF to_regclass(format('%I.deals', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I.deals
           ADD COLUMN IF NOT EXISTS project_type text,
           ADD COLUMN IF NOT EXISTS intended_project_number text',
        tenant_schema
      );

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'deals_project_type_allowlist_chk'
          AND conrelid = format('%I.deals', tenant_schema)::regclass
      ) THEN
        EXECUTE format(
          'ALTER TABLE %I.deals
             ADD CONSTRAINT deals_project_type_allowlist_chk
             CHECK (
               project_type IS NULL OR project_type IN (
                 ''exterior renovation'',
                 ''interior renovation'',
                 ''roofing'',
                 ''service'',
                 ''commercial'',
                 ''hospitality'',
                 ''emergency'',
                 ''development'',
                 ''residential''
               )
             )',
          tenant_schema
        );
      END IF;

      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.deal_history (
           id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
           deal_id uuid NOT NULL REFERENCES %I.deals(id),
           field_name text NOT NULL,
           old_value text,
           new_value text,
           changed_by uuid NOT NULL REFERENCES public.users(id),
           changed_at timestamptz NOT NULL DEFAULT NOW()
         )',
        tenant_schema,
        tenant_schema
      );

      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS deal_history_deal_id_changed_at_idx
           ON %I.deal_history (deal_id, changed_at DESC)',
        tenant_schema
      );
    END IF;
  END LOOP;
END $$;
