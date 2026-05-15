-- 0120_audit_log_dedup_partial_index.sql
-- Existing tenant schemas are handled by server/src/migrations/runner.ts because
-- CREATE INDEX CONCURRENTLY cannot run inside a DO block or transactional tenant loop.
-- This file retains the tenant DDL for future office provisioning, where plain
-- CREATE INDEX IF NOT EXISTS is safe because the schema is created inside a
-- provisioning transaction and has no live write traffic yet.

-- TENANT_SCHEMA_START
CREATE INDEX IF NOT EXISTS audit_log_dedup_rich_lookup_idx
  ON office_dallas.audit_log (table_name, record_id, action, created_at DESC)
  WHERE actor_system_process IS NOT NULL
     OR actor_name IS NOT NULL
     OR entity_name_snapshot IS NOT NULL
     OR field_changes_jsonb IS NOT NULL;

CREATE INDEX IF NOT EXISTS audit_log_actor_system_process_created_at_idx
  ON office_dallas.audit_log (actor_system_process, created_at DESC)
  WHERE actor_system_process IS NOT NULL;

CREATE INDEX IF NOT EXISTS audit_log_entity_or_table_created_at_idx
  ON office_dallas.audit_log ((COALESCE(entity_type, table_name)), created_at DESC);
-- TENANT_SCHEMA_END
