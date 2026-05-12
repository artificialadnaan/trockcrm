-- Track CompanyCam bulk import progress per tenant.
DO $$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name LIKE 'office_%'
  LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.companycam_import_state (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        companycam_project_id text NOT NULL,
        companycam_photo_id text NOT NULL,
        deal_id uuid,
        status text NOT NULL DEFAULT ''imported'',
        import_started_at timestamptz DEFAULT now() NOT NULL,
        imported_at timestamptz,
        error text,
        metadata jsonb NOT NULL DEFAULT ''{}''::jsonb,
        created_at timestamptz DEFAULT now() NOT NULL,
        updated_at timestamptz DEFAULT now() NOT NULL
      )',
      tenant_schema
    );
    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS companycam_import_state_photo_uidx
         ON %I.companycam_import_state (companycam_photo_id)',
      tenant_schema
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS companycam_import_state_project_idx
         ON %I.companycam_import_state (companycam_project_id, status)',
      tenant_schema
    );
  END LOOP;
END $$;
