-- Migration 0032: Ensure every tenant schema has the audit_log table required by audit triggers.
-- Some production office schemas are missing this table, which causes worker-side email sync writes
-- to fail once the runtime import path bug is fixed and the audit trigger actually runs.

DO $$
DECLARE
  tenant_schema TEXT;
  tenant_sql TEXT := $tenant_migration$
DO $tenant$
BEGIN
  CREATE TABLE IF NOT EXISTS audit_log (
    id          BIGSERIAL PRIMARY KEY,
    table_name  VARCHAR(100) NOT NULL,
    record_id   UUID NOT NULL,
    action      public.audit_action NOT NULL,
    changed_by  UUID,
    changes     JSONB,
    full_row    JSONB,
    ip_address  INET,
    user_agent  VARCHAR(500),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS audit_record_idx
    ON audit_log (table_name, record_id, created_at);

  CREATE INDEX IF NOT EXISTS audit_user_idx
    ON audit_log (changed_by, created_at);

  CREATE INDEX IF NOT EXISTS audit_time_idx
    ON audit_log (created_at);
END $tenant$;
$tenant_migration$;
BEGIN
  FOR tenant_schema IN
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name LIKE 'office_%'
  LOOP
    EXECUTE format('SET LOCAL search_path = %I, public', tenant_schema);
    EXECUTE tenant_sql;
    RAISE NOTICE 'Ensured audit_log exists in schema: %', tenant_schema;
  END LOOP;
END $$;

-- TENANT_SCHEMA_START
DO $tenant$
BEGIN
  CREATE TABLE IF NOT EXISTS audit_log (
    id          BIGSERIAL PRIMARY KEY,
    table_name  VARCHAR(100) NOT NULL,
    record_id   UUID NOT NULL,
    action      public.audit_action NOT NULL,
    changed_by  UUID,
    changes     JSONB,
    full_row    JSONB,
    ip_address  INET,
    user_agent  VARCHAR(500),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS audit_record_idx
    ON audit_log (table_name, record_id, created_at);

  CREATE INDEX IF NOT EXISTS audit_user_idx
    ON audit_log (changed_by, created_at);

  CREATE INDEX IF NOT EXISTS audit_time_idx
    ON audit_log (created_at);
END $tenant$;
-- TENANT_SCHEMA_END
