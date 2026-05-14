import { describe, expect, it, vi } from "vitest";
import { ensureAuditLogPhase1Columns } from "../../../src/modules/audit/startup-migration.js";

describe("ensureAuditLogPhase1Columns", () => {
  it("runs a single idempotent bootstrap statement", async () => {
    const query = vi.fn().mockResolvedValue(undefined);

    await ensureAuditLogPhase1Columns({ query });

    expect(query).toHaveBeenCalledOnce();
    expect(String(query.mock.calls[0]?.[0])).toContain("ADD COLUMN IF NOT EXISTS actor_name");
    expect(String(query.mock.calls[0]?.[0])).toContain("CREATE INDEX IF NOT EXISTS audit_log_entity_type_created_idx");
  });
});
