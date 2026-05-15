import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it, vi } from "vitest";
import {
  AUDIT_LOG_PERFORMANCE_MIGRATION,
  AUDIT_LOG_INDEX_SPECS,
  buildAuditLogPerformanceIndexStatements,
  OFFICE_SCHEMA_DISCOVERY_SQL,
  runAuditLogPerformanceIndexMigration,
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

    expect(statements).toHaveLength(6);
    expect(statements[0]).toContain("DROP INDEX CONCURRENTLY IF EXISTS \"office_dallas\".audit_log_dedup_rich_lookup_idx");
    expect(statements[1]).toContain("CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_dedup_rich_lookup_idx");
    expect(statements[1]).toContain("ON \"office_dallas\".audit_log (table_name, record_id, action, created_at DESC)");
    expect(statements[1]).toContain("field_changes_jsonb IS NOT NULL");
    expect(statements[2]).toContain("DROP INDEX CONCURRENTLY IF EXISTS \"office_dallas\".audit_log_actor_system_process_created_at_idx");
    expect(statements[3]).toContain("CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_actor_system_process_created_at_idx");
    expect(statements[3]).toContain("(actor_system_process, created_at DESC)");
    expect(statements[4]).toContain("DROP INDEX CONCURRENTLY IF EXISTS \"office_dallas\".audit_log_entity_or_table_created_at_idx");
    expect(statements[5]).toContain("CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_entity_or_table_created_at_idx");
    expect(statements[5]).toContain("COALESCE(entity_type, table_name)");
  });

  it("drops and recreates invalid indexes before relying on them", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ schema_name: "office_dallas" }] })
      .mockResolvedValueOnce({
        rows: [
          { index_name: AUDIT_LOG_INDEX_SPECS[0].name, is_valid: false },
          { index_name: AUDIT_LOG_INDEX_SPECS[1].name, is_valid: true },
          { index_name: AUDIT_LOG_INDEX_SPECS[2].name, is_valid: true },
        ],
      })
      .mockResolvedValue(undefined)
      .mockResolvedValue(undefined)
      .mockResolvedValue(undefined)
      .mockResolvedValue(undefined);

    await runAuditLogPerformanceIndexMigration({ query } as never);

    expect(query).toHaveBeenCalledTimes(6);
    expect(query.mock.calls[2]?.[0]).toContain("DROP INDEX CONCURRENTLY IF EXISTS \"office_dallas\".audit_log_dedup_rich_lookup_idx");
    expect(query.mock.calls[3]?.[0]).toContain("CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_dedup_rich_lookup_idx");
    expect(query.mock.calls[4]?.[0]).toContain("CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_actor_system_process_created_at_idx");
    expect(query.mock.calls[5]?.[0]).toContain("CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_entity_or_table_created_at_idx");
  });

  it("does not drop a valid index before recreating safeguards", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ schema_name: "office_dallas" }] })
      .mockResolvedValueOnce({
        rows: AUDIT_LOG_INDEX_SPECS.map((spec) => ({ index_name: spec.name, is_valid: true })),
      })
      .mockResolvedValue(undefined)
      .mockResolvedValue(undefined)
      .mockResolvedValue(undefined);

    await runAuditLogPerformanceIndexMigration({ query } as never);

    const sqlCalls = query.mock.calls.map((call) => String(call[0]));

    expect(sqlCalls.some((statement) => statement.includes("DROP INDEX CONCURRENTLY"))).toBe(false);
    expect(sqlCalls.filter((statement) => statement.includes("CREATE INDEX CONCURRENTLY IF NOT EXISTS"))).toHaveLength(3);
  });

  it("creates missing indexes for discovered office schemas", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ schema_name: "office_dallas" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValue(undefined)
      .mockResolvedValue(undefined)
      .mockResolvedValue(undefined);

    await runAuditLogPerformanceIndexMigration({ query } as never);

    const sqlCalls = query.mock.calls.map((call) => String(call[0]));

    expect(sqlCalls.filter((statement) => statement.includes("CREATE INDEX CONCURRENTLY IF NOT EXISTS"))).toHaveLength(3);
    expect(sqlCalls.some((statement) => statement.includes("DROP INDEX CONCURRENTLY"))).toBe(false);
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
