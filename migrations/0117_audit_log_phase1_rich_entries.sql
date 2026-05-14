DO $tenant$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname LIKE 'office\_%' ESCAPE '\'
    ORDER BY nspname
  LOOP
    EXECUTE format(
      $sql$
        ALTER TABLE %I.audit_log
          ADD COLUMN IF NOT EXISTS actor_name text,
          ADD COLUMN IF NOT EXISTS actor_role text,
          ADD COLUMN IF NOT EXISTS actor_system_process text,
          ADD COLUMN IF NOT EXISTS entity_type text,
          ADD COLUMN IF NOT EXISTS entity_name_snapshot text,
          ADD COLUMN IF NOT EXISTS entity_secondary_id_snapshot text,
          ADD COLUMN IF NOT EXISTS impersonator_id uuid,
          ADD COLUMN IF NOT EXISTS field_changes_jsonb jsonb,
          ADD COLUMN IF NOT EXISTS visibility_scope text;

        CREATE INDEX IF NOT EXISTS audit_log_entity_type_created_idx
          ON %I.audit_log (entity_type, created_at DESC);

        CREATE INDEX IF NOT EXISTS audit_log_visibility_scope_created_idx
          ON %I.audit_log (visibility_scope, created_at DESC);
      $sql$,
      tenant_schema,
      tenant_schema,
      tenant_schema
    );
  END LOOP;
END
$tenant$;
