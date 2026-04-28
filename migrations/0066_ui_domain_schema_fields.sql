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
           ADD COLUMN IF NOT EXISTS sales_rep_id uuid',
        tenant_schema
      );

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'leads_sales_rep_id_users_id_fk'
          AND conrelid = format('%I.leads', tenant_schema)::regclass
      ) THEN
        EXECUTE format(
          'ALTER TABLE %I.leads
             ADD CONSTRAINT leads_sales_rep_id_users_id_fk
             FOREIGN KEY (sales_rep_id)
             REFERENCES public.users(id)
             ON DELETE SET NULL',
          tenant_schema
        );
      END IF;
    END IF;

    IF to_regclass(format('%I.deals', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I.deals
           ADD COLUMN IF NOT EXISTS proposal_draft_started_at timestamptz',
        tenant_schema
      );
    END IF;
  END LOOP;
END $$;
