import { describe, expect, it, vi } from "vitest";

import { AUDIT_ACTIONS } from "@trock-crm/shared/types";
import { buildSoftDeleteAuditEntry, writeSoftDeleteAuditLog } from "../../src/lib/soft-delete-audit.js";

describe("soft-delete audit log", () => {
  it("exposes soft_delete as an audit action", () => {
    expect(AUDIT_ACTIONS).toContain("soft_delete");
  });

  it("builds a consistent soft-delete audit entry", () => {
    expect(
      buildSoftDeleteAuditEntry({
        actorUserId: "user-1",
        entityType: "deal",
        entityId: "deal-1",
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
      })
    ).toEqual({
      tableName: "deal",
      recordId: "deal-1",
      action: "soft_delete",
      changedBy: "user-1",
      changes: {
        deleted: { from: false, to: true },
      },
      fullRow: null,
      ipAddress: "127.0.0.1",
      userAgent: "vitest",
    });
  });

  it("writes the soft-delete audit entry through the tenant audit log table", async () => {
    const values = vi.fn();
    const tenantDb = {
      insert: vi.fn(() => ({ values })),
    };

    await writeSoftDeleteAuditLog(tenantDb as never, {
      actorUserId: "user-1",
      entityType: "company",
      entityId: "company-1",
      reason: "duplicate",
    });

    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      tableName: "company",
      recordId: "company-1",
      action: "soft_delete",
      changedBy: "user-1",
      fullRow: { reason: "duplicate" },
    }));
  });
});
