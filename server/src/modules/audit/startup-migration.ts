type Queryable = {
  query: (sqlText: string, params?: unknown[]) => Promise<unknown>;
};

const AUDIT_LOG_PHASE_1_SQL = `
DO $tenant$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name LIKE 'office\\_%' ESCAPE '\\'
  LOOP
    EXECUTE format('ALTER TABLE %I.audit_log ADD COLUMN IF NOT EXISTS actor_name text', tenant_schema);
    EXECUTE format('ALTER TABLE %I.audit_log ADD COLUMN IF NOT EXISTS actor_role text', tenant_schema);
    EXECUTE format('ALTER TABLE %I.audit_log ADD COLUMN IF NOT EXISTS actor_system_process text', tenant_schema);
    EXECUTE format('ALTER TABLE %I.audit_log ADD COLUMN IF NOT EXISTS entity_type text', tenant_schema);
    EXECUTE format('ALTER TABLE %I.audit_log ADD COLUMN IF NOT EXISTS entity_name_snapshot text', tenant_schema);
    EXECUTE format('ALTER TABLE %I.audit_log ADD COLUMN IF NOT EXISTS entity_secondary_id_snapshot text', tenant_schema);
    EXECUTE format('ALTER TABLE %I.audit_log ADD COLUMN IF NOT EXISTS impersonator_id uuid', tenant_schema);
    EXECUTE format('ALTER TABLE %I.audit_log ADD COLUMN IF NOT EXISTS field_changes_jsonb jsonb', tenant_schema);
    EXECUTE format('ALTER TABLE %I.audit_log ADD COLUMN IF NOT EXISTS visibility_scope text', tenant_schema);
    EXECUTE format('CREATE INDEX IF NOT EXISTS audit_log_entity_type_created_idx ON %I.audit_log (entity_type, created_at)', tenant_schema);
    EXECUTE format('CREATE INDEX IF NOT EXISTS audit_log_visibility_scope_created_idx ON %I.audit_log (visibility_scope, created_at)', tenant_schema);
  END LOOP;
END
$tenant$;
`;

export async function ensureAuditLogPhase1Columns(queryable: Queryable) {
  await queryable.query(AUDIT_LOG_PHASE_1_SQL);
}
