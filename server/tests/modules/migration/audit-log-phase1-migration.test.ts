import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  import.meta.dirname,
  "../../../../migrations/0117_audit_log_phase1_rich_entries.sql"
);
const migrationSql = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";

describe("audit log phase 1 rich entries migration", () => {
  it("exists as a dedicated migration file", () => {
    expect(existsSync(migrationPath)).toBe(true);
  });

  it("adds the new audit columns for actor, entity, and visibility metadata", () => {
    expect(migrationSql).toContain("ALTER TABLE %I.audit_log");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS actor_name text");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS actor_role text");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS actor_system_process text");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS entity_type text");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS entity_name_snapshot text");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS entity_secondary_id_snapshot text");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS impersonator_id uuid");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS field_changes_jsonb jsonb");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS visibility_scope text");
  });

  it("replays across every tenant schema and remains idempotent", () => {
    expect(migrationSql).toContain("DO $tenant$");
    expect(migrationSql).toContain("FOR tenant_schema IN");
    expect(migrationSql).toContain("WHERE nspname LIKE 'office\\_%' ESCAPE '\\'");
    expect(migrationSql).toContain("CREATE INDEX IF NOT EXISTS audit_log_entity_type_created_idx");
    expect(migrationSql).toContain("CREATE INDEX IF NOT EXISTS audit_log_visibility_scope_created_idx");
  });
});
