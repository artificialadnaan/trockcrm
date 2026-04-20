DO $$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname LIKE 'office\_%' ESCAPE '\'
      AND EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = nspname
          AND table_name = 'deals'
      )
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.deals
         ALTER COLUMN assigned_rep_id DROP NOT NULL,
         ADD COLUMN IF NOT EXISTS hubspot_owner_id varchar(64),
         ADD COLUMN IF NOT EXISTS hubspot_owner_email varchar(320),
         ADD COLUMN IF NOT EXISTS ownership_synced_at timestamptz,
         ADD COLUMN IF NOT EXISTS ownership_sync_status varchar(32),
         ADD COLUMN IF NOT EXISTS unassigned_reason_code varchar(64)',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS deals_hubspot_owner_id_idx ON %I.deals (hubspot_owner_id)',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS deals_ownership_sync_status_idx ON %I.deals (ownership_sync_status)',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS deals_unassigned_reason_code_idx ON %I.deals (unassigned_reason_code)',
      schema_name
    );
  END LOOP;
END $$;
