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
           ADD COLUMN IF NOT EXISTS office_code text',
        tenant_schema
      );

      EXECUTE format(
        'UPDATE %I.leads
            SET office_code = ''dfw''
          WHERE office_code IS NULL',
        tenant_schema
      );

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'leads_office_code_allowlist_chk'
          AND conrelid = format('%I.leads', tenant_schema)::regclass
      ) THEN
        EXECUTE format(
          'ALTER TABLE %I.leads
             ADD CONSTRAINT leads_office_code_allowlist_chk
             CHECK (office_code IN (''dfw'', ''atl''))',
          tenant_schema
        );
      END IF;

      EXECUTE format(
        'ALTER TABLE %I.leads
           ALTER COLUMN office_code SET DEFAULT ''dfw'',
           ALTER COLUMN office_code SET NOT NULL',
        tenant_schema
      );
    END IF;

    IF to_regclass(format('%I.deals', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I.deals
           ADD COLUMN IF NOT EXISTS office_code text',
        tenant_schema
      );

      EXECUTE format(
        'UPDATE %I.deals d
            SET office_code = COALESCE(l.office_code, ''dfw'')
           FROM %I.leads l
          WHERE d.source_lead_id = l.id
            AND d.office_code IS NULL',
        tenant_schema,
        tenant_schema
      );

      EXECUTE format(
        'UPDATE %I.deals
            SET office_code = ''dfw''
          WHERE office_code IS NULL',
        tenant_schema
      );

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'deals_office_code_allowlist_chk'
          AND conrelid = format('%I.deals', tenant_schema)::regclass
      ) THEN
        EXECUTE format(
          'ALTER TABLE %I.deals
             ADD CONSTRAINT deals_office_code_allowlist_chk
             CHECK (office_code IN (''dfw'', ''atl''))',
          tenant_schema
        );
      END IF;
    END IF;
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS public.deal_number_daily_sequences (
  day_key text PRIMARY KEY,
  last_suffix text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);
