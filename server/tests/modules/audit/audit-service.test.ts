import { describe, expect, it, vi } from "vitest";
import { getAuditLog } from "../../../src/modules/admin/audit-service.js";

function extractSqlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray((value as { queryChunks?: unknown[] })?.queryChunks)) {
    return ((value as { queryChunks: unknown[] }).queryChunks).map(extractSqlText).join("");
  }
  if (value && typeof value === "object" && "value" in value) {
    return extractSqlText((value as { value: unknown }).value);
  }
  return String(value ?? "");
}

describe("audit activity feed dedup", () => {
  it("filters legacy trigger rows when a rich row exists for the same write second", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ total: 1 }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 101,
          action: "update",
          entity_type: "deal",
          entity_name: "Rich Deal",
          entity_secondary_id_snapshot: "DFW-1-11526-aa",
          actor_label: "Bid Board Sync",
          actor_type: "system",
          field_changes_jsonb: [],
          visibility_scope: "internal",
          created_at: "2026-05-15T10:00:00.000Z",
        }],
      });

    const result = await getAuditLog({ execute } as never, "admin");
    const sqlText = execute.mock.calls.map((call) => extractSqlText(call[0])).join("\n");

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].actorLabel).toBe("Bid Board Sync");
    expect(sqlText).toContain("date_trunc('second'");
    expect(sqlText).toContain("rich.actor_system_process IS NOT NULL");
    expect(sqlText).toContain("al.actor_name IS NULL");
  });
});
