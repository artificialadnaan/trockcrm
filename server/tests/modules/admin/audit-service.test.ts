import { describe, expect, it, vi } from "vitest";
import { getAuditLog } from "../../../src/modules/admin/audit-service.js";

function makeExpandedRow(id: number) {
  return {
    id,
    action: "update",
    entity_type: "deals",
    entity_name: `Deal ${id}`,
    entity_secondary_id_snapshot: `DFW-${id}`,
    actor_system_process: "Bid Board Sync",
    record_id: `deal-${id}`,
    actor_label: "Bid Board Sync",
    actor_type: "system",
    field_changes_jsonb: [],
    visibility_scope: "internal",
    created_at: "2026-05-15T10:00:00.000Z",
  };
}

describe("expanded audit log pagination", () => {
  it.each([
    { page: 0, limit: 100, rowCount: 20, total: 20, expected: false },
    { page: 3, limit: 100, rowCount: 20, total: 220, expected: false },
    { page: 2, limit: 100, rowCount: 100, total: 220, expected: true },
    { page: 2, limit: 100, rowCount: 100, total: 200, expected: false },
    { page: 1, limit: 100, rowCount: 50, total: 50, expected: false },
    { page: 1, limit: 100, rowCount: 100, total: 200, expected: true },
  ])(
    "computes hasMore for page $page limit $limit rows $rowCount total $total",
    async ({ page, limit, rowCount, total, expected }) => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ total }] })
        .mockResolvedValueOnce({ rows: Array.from({ length: rowCount }, (_, index) => makeExpandedRow(index + 1)) });

      const result = await getAuditLog({ execute } as never, "admin", {
        expand: "batch:eyJwcm9jZXNzTmFtZSI6IkJpZCBCb2FyZCBTeW5jIiwiZW50aXR5VHlwZSI6ImRlYWxzIiwiYWN0aW9uIjoidXBkYXRlIiwic3RhcnRUaW1lIjoiMjAyNi0wNS0xNVQxMDowMDowMC4wMDBaIiwiZW5kVGltZSI6IjIwMjYtMDUtMTVUMTA6MDA6MDAuMDAwWiJ9",
        page,
        limit,
      });

      expect(result.rows).toHaveLength(rowCount);
      expect(result.total).toBe(total);
      expect(result.hasMore).toBe(expected);
    }
  );
});
