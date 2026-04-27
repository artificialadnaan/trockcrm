-- Migration 0058: allow files to attach directly to leads.
-- 0044 added files.lead_id, but the original association check still rejected
-- rows that only had lead_id set. This keeps the existing check additive and
-- idempotently expands it to include lead attachments.

DO $$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name NOT IN ('public', 'information_schema', 'pg_catalog')
      AND schema_name NOT LIKE 'pg_%'
  LOOP
    IF to_regclass(format('%I.files', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %1$I.files
           ADD COLUMN IF NOT EXISTS lead_id UUID',
        tenant_schema
      );

      IF to_regclass(format('%I.leads', tenant_schema)) IS NOT NULL THEN
        EXECUTE format(
          'DO $inner$
           BEGIN
             IF NOT EXISTS (
               SELECT 1
               FROM pg_constraint
               WHERE conname = %2$L
                 AND conrelid = %1$L::regclass
             ) THEN
               ALTER TABLE %1$s
                 ADD CONSTRAINT files_lead_id_fkey
                 FOREIGN KEY (lead_id) REFERENCES %3$s(id);
             END IF;
           END
           $inner$',
          format('%I.files', tenant_schema),
          'files_lead_id_fkey',
          format('%I.leads', tenant_schema)
        );
      END IF;

      EXECUTE format(
        'ALTER TABLE %1$I.files
           DROP CONSTRAINT IF EXISTS files_association_check',
        tenant_schema
      );
      EXECUTE format(
        'ALTER TABLE %1$I.files
           ADD CONSTRAINT files_association_check
           CHECK (
             deal_id IS NOT NULL
             OR lead_id IS NOT NULL
             OR contact_id IS NOT NULL
             OR procore_project_id IS NOT NULL
             OR change_order_id IS NOT NULL
           )',
        tenant_schema
      );
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS files_lead_idx
           ON %1$I.files(lead_id, category, created_at)',
        tenant_schema
      );
    END IF;
  END LOOP;
END $$;
