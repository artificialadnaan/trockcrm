import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import {
  AUDIT_LOG_PERFORMANCE_MIGRATION,
  buildAuditLogPerformanceIndexStatements,
  OFFICE_SCHEMA_DISCOVERY_SQL,
} from "../../../src/migrations/audit-log-performance-indexes.js";

const migrationPath = resolve(
  import.meta.dirname,
  "../../../../migrations/0120_audit_log_dedup_partial_index.sql"
);

describe("audit log performance index migration", () => {
  it("uses an escaped office schema pattern for dynamic tenant discovery", () => {
    expect(OFFICE_SCHEMA_DISCOVERY_SQL).toContain("LIKE 'office\\_%' ESCAPE '\\'");
  });

  it("builds concurrent per-tenant audit index statements", () => {
    const statements = buildAuditLogPerformanceIndexStatements("office_dallas");

    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain("CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_dedup_rich_lookup_idx");
    expect(statements[0]).toContain("ON \"office_dallas\".audit_log (table_name, record_id, action, created_at DESC)");
    expect(statements[0]).toContain("field_changes_jsonb IS NOT NULL");
    expect(statements[1]).toContain("CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_actor_system_process_created_at_idx");
    expect(statements[1]).toContain("(actor_system_process, created_at DESC)");
    expect(statements[2]).toContain("CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_entity_or_table_created_at_idx");
    expect(statements[2]).toContain("COALESCE(entity_type, table_name)");
  });

  it("keeps the migration file append-only and ready for new office provisioning", () => {
    const sql = readFileSync(migrationPath, "utf8");

    expect(AUDIT_LOG_PERFORMANCE_MIGRATION).toBe("0120_audit_log_dedup_partial_index.sql");
    expect(sql).toContain("-- TENANT_SCHEMA_START");
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS audit_log_dedup_rich_lookup_idx");
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS audit_log_actor_system_process_created_at_idx");
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS audit_log_entity_or_table_created_at_idx");
    expect(sql).toContain("server/src/migrations/runner.ts");
  });
});
