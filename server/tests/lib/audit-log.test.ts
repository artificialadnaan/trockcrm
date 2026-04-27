import { describe, expect, it, vi } from "vitest";
import { writeAuditLog } from "../../src/lib/audit-log.js";

describe("writeAuditLog", () => {
  function makeTenantDb() {
    const inserts: Array<Record<string, unknown>> = [];
    const tenantDb = {
      _inserts: inserts,
      insert(_table: unknown) {
        return {
          values(value: Record<string, unknown>) {
            inserts.push(value);
            return Promise.resolve();
          },
        };
      },
    };
    return tenantDb;
  }

  it("inserts a single row with all caller-provided fields", async () => {
    const tenantDb = makeTenantDb();
    await writeAuditLog(tenantDb as never, {
      tableName: "deals",
      recordId: "deal-1",
      action: "update",
      changedBy: "user-1",
      changes: { contractSignedDate: { from: null, to: "2026-09-15" } },
    });

    expect(tenantDb._inserts).toHaveLength(1);
    expect(tenantDb._inserts[0]).toMatchObject({
      tableName: "deals",
      recordId: "deal-1",
      action: "update",
      changedBy: "user-1",
      changes: { contractSignedDate: { from: null, to: "2026-09-15" } },
      fullRow: null,
      ipAddress: null,
      userAgent: null,
    });
  });

  it("defaults missing optional fields to null", async () => {
    const tenantDb = makeTenantDb();
    await writeAuditLog(tenantDb as never, {
      tableName: "companies",
      recordId: "company-1",
      action: "insert",
      changedBy: null,
    });
    expect(tenantDb._inserts[0]).toMatchObject({
      changes: null,
      fullRow: null,
      ipAddress: null,
      userAgent: null,
    });
  });

  it("passes through fullRow when provided", async () => {
    const tenantDb = makeTenantDb();
    const snapshot = { id: "deal-1", name: "Test", contractSignedDate: "2026-09-15" };
    await writeAuditLog(tenantDb as never, {
      tableName: "deals",
      recordId: "deal-1",
      action: "update",
      changedBy: "user-1",
      fullRow: snapshot,
    });
    expect(tenantDb._inserts[0]?.fullRow).toEqual(snapshot);
  });
});
