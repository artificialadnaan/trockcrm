import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it, vi } from "vitest";
import {
  OFFICE_SCHEMA_DISCOVERY_SQL,
  PROJECT_NUMBER_FIRST_SET_INDEX_NAME,
  PROJECT_NUMBER_FIRST_SET_MIGRATION,
  buildProjectNumberFirstSetIndexStatement,
  runProjectNumberFirstSetIndexMigration,
} from "../../../src/migrations/project-number-first-set-index.js";

const migrationPath = resolve(
  import.meta.dirname,
  "../../../../migrations/0138_project_number_first_set_notification.sql"
);

describe("project number first-set index migration (CONCURRENTLY)", () => {
  it("uses an escaped office schema pattern for dynamic tenant discovery", () => {
    expect(OFFICE_SCHEMA_DISCOVERY_SQL).toContain("LIKE 'office\\_%' ESCAPE '\\'");
  });

  it("builds a per-tenant CREATE UNIQUE INDEX CONCURRENTLY statement", () => {
    const statement = buildProjectNumberFirstSetIndexStatement("office_dallas");
    expect(statement).toContain("CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS");
    expect(statement).toContain(PROJECT_NUMBER_FIRST_SET_INDEX_NAME);
    expect(statement).toContain('"office_dallas".audit_log (record_id)');
    expect(statement).toContain("table_name = 'deals'");
    expect(statement).toContain("actor_system_process = 'project_number_first_set'");
  });

  it("rejects invalid office schema names to avoid identifier injection", () => {
    expect(() => buildProjectNumberFirstSetIndexStatement("public; DROP TABLE foo")).toThrow(
      /Invalid office schema name/
    );
    expect(() => buildProjectNumberFirstSetIndexStatement("OFFICE_DALLAS")).toThrow(
      /Invalid office schema name/
    );
  });

  it("creates the unique index for each discovered tenant", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ schema_name: "office_dallas" }, { schema_name: "office_atlanta" }],
      })
      .mockResolvedValueOnce({ rows: [] }) // dallas: index not present
      .mockResolvedValueOnce(undefined) // dallas CREATE
      .mockResolvedValueOnce({ rows: [] }) // atlanta: index not present
      .mockResolvedValueOnce(undefined); // atlanta CREATE

    await runProjectNumberFirstSetIndexMigration({ query } as never);

    const sqlCalls = query.mock.calls.map((call) => String(call[0]));
    const createCalls = sqlCalls.filter((statement) =>
      statement.includes("CREATE UNIQUE INDEX CONCURRENTLY")
    );
    expect(createCalls).toHaveLength(2);
    expect(createCalls[0]).toContain('"office_dallas"');
    expect(createCalls[1]).toContain('"office_atlanta"');
    expect(sqlCalls.some((statement) => statement.includes("DROP INDEX CONCURRENTLY"))).toBe(false);
  });

  it("drops an invalid index before recreating it CONCURRENTLY", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ schema_name: "office_dallas" }] })
      .mockResolvedValueOnce({ rows: [{ is_valid: false }] })
      .mockResolvedValueOnce(undefined) // DROP
      .mockResolvedValueOnce(undefined); // CREATE

    await runProjectNumberFirstSetIndexMigration({ query } as never);

    const sqlCalls = query.mock.calls.map((call) => String(call[0]));
    expect(sqlCalls[2]).toContain("DROP INDEX CONCURRENTLY");
    expect(sqlCalls[2]).toContain(PROJECT_NUMBER_FIRST_SET_INDEX_NAME);
    expect(sqlCalls[3]).toContain("CREATE UNIQUE INDEX CONCURRENTLY");
  });

  it("does not drop a valid existing index before creation", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ schema_name: "office_dallas" }] })
      .mockResolvedValueOnce({ rows: [{ is_valid: true }] })
      .mockResolvedValueOnce(undefined);

    await runProjectNumberFirstSetIndexMigration({ query } as never);

    const sqlCalls = query.mock.calls.map((call) => String(call[0]));
    expect(sqlCalls.some((statement) => statement.includes("DROP INDEX CONCURRENTLY"))).toBe(false);
    expect(sqlCalls.filter((statement) => statement.includes("CREATE UNIQUE INDEX CONCURRENTLY"))).toHaveLength(1);
  });

  it("keeps the migration SQL file annotated for the runner intercept", () => {
    const sql = readFileSync(migrationPath, "utf8");

    expect(PROJECT_NUMBER_FIRST_SET_MIGRATION).toBe(
      "0138_project_number_first_set_notification.sql"
    );
    expect(sql).toContain("server/src/migrations/runner.ts");
    expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS audit_log_project_number_first_set_uidx");
    expect(sql).toContain("-- TENANT_SCHEMA_START");
  });
});
