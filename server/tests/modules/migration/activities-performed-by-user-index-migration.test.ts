import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it, vi } from "vitest";
import {
  ACTIVITIES_PERFORMED_BY_USER_INDEX_NAME,
  ACTIVITIES_PERFORMED_BY_USER_MIGRATION,
  buildActivitiesPerformedByUserIndexStatement,
  runActivitiesPerformedByUserIndexMigration,
} from "../../../src/migrations/activities-performed-by-user-index.js";

const migrationPath = resolve(
  import.meta.dirname,
  "../../../../migrations/0222_activities_performed_by_user_index.sql"
);

describe("activities.performed_by_user_id index migration (CONCURRENTLY, every tenant)", () => {
  it("builds the index CONCURRENTLY in EVERY office schema, one statement at a time", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ schema_name: "office_dallas" }, { schema_name: "office_atlanta" }] })
      .mockResolvedValueOnce({ rows: [] }) // dallas: index absent
      .mockResolvedValueOnce(undefined) // dallas CREATE
      .mockResolvedValueOnce({ rows: [] }) // atlanta: index absent
      .mockResolvedValueOnce(undefined); // atlanta CREATE

    await runActivitiesPerformedByUserIndexMigration({ query } as never);

    const sql = query.mock.calls.map((call) => String(call[0]));
    const creates = sql.filter((s) => s.includes("INDEX CONCURRENTLY"));
    expect(creates).toHaveLength(2);
    expect(creates[0]).toContain(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${ACTIVITIES_PERFORMED_BY_USER_INDEX_NAME}`
    );
    expect(creates[0]).toContain(`"office_dallas".activities (performed_by_user_id, deal_id)`);
    expect(creates[0]).toContain("WHERE performed_by_user_id IS NOT NULL");
    expect(creates[1]).toContain(`"office_atlanta".activities (performed_by_user_id, deal_id)`);
    expect(sql.some((s) => s.includes("DROP INDEX CONCURRENTLY"))).toBe(false);
  });

  it("drops an INVALID stub from an interrupted build before recreating it", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ schema_name: "office_dallas" }] })
      .mockResolvedValueOnce({ rows: [{ is_valid: false }] })
      .mockResolvedValueOnce(undefined) // DROP
      .mockResolvedValueOnce(undefined); // CREATE

    await runActivitiesPerformedByUserIndexMigration({ query } as never);

    const sql = query.mock.calls.map((call) => String(call[0]));
    const drops = sql.filter((s) => s.includes("DROP INDEX CONCURRENTLY"));
    expect(drops).toHaveLength(1);
    expect(drops[0]).toContain(
      `DROP INDEX CONCURRENTLY IF EXISTS "office_dallas".${ACTIVITIES_PERFORMED_BY_USER_INDEX_NAME}`
    );
  });

  it("leaves a VALID index alone (the CREATE then no-ops via IF NOT EXISTS)", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ schema_name: "office_dallas" }] })
      .mockResolvedValueOnce({ rows: [{ is_valid: true }] })
      .mockResolvedValueOnce(undefined);

    await runActivitiesPerformedByUserIndexMigration({ query } as never);

    const sql = query.mock.calls.map((call) => String(call[0]));
    expect(sql.some((s) => s.includes("DROP INDEX CONCURRENTLY"))).toBe(false);
    expect(sql.filter((s) => s.includes("INDEX CONCURRENTLY IF NOT EXISTS"))).toHaveLength(1);
  });

  it("rejects a schema name that is not an office schema", () => {
    expect(() => buildActivitiesPerformedByUserIndexStatement("public")).toThrow(
      /Invalid office schema name/
    );
    expect(() => buildActivitiesPerformedByUserIndexStatement('office_x"; DROP TABLE deals; --')).toThrow(
      /Invalid office schema name/
    );
  });

  it("keeps the migration SQL file in lockstep: runner intercept, plain no-op, and a NEW-TENANT block", () => {
    const sql = readFileSync(migrationPath, "utf8");
    expect(ACTIVITIES_PERFORMED_BY_USER_MIGRATION).toBe("0222_activities_performed_by_user_index.sql");
    // The runner intercepts this file to build every tenant's index CONCURRENTLY first.
    expect(sql).toContain("server/src/migrations/activities-performed-by-user-index.ts");
    // The in-file plain build stays (it no-ops via IF NOT EXISTS once the helper has built it).
    expect(sql).toContain(`CREATE INDEX IF NOT EXISTS ${ACTIVITIES_PERFORMED_BY_USER_INDEX_NAME}`);
    // A tenant column/index add needs BOTH the DO-loop over existing schemas AND a TENANT_SCHEMA block,
    // or an office provisioned after this deploy silently falls back to a full scan of its activities.
    expect(sql).toContain("-- TENANT_SCHEMA_START");
    expect(sql).toContain("-- TENANT_SCHEMA_END");
    const tenantBlock = sql.slice(
      sql.indexOf("-- TENANT_SCHEMA_START"),
      sql.indexOf("-- TENANT_SCHEMA_END")
    );
    expect(tenantBlock).toContain("office_dallas.activities (performed_by_user_id, deal_id)");
    expect(tenantBlock).toContain("WHERE performed_by_user_id IS NOT NULL");
  });
});
