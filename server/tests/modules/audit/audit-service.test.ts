import { describe, expect, it, vi } from "vitest";
import { getAuditLog, groupAuditLogRows } from "../../../src/modules/admin/audit-service.js";

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

function makeAuditRow(overrides: Record<string, unknown> = {}) {
  const id = Number(overrides.id ?? 1);
  return {
    type: "single" as const,
    id,
    actorLabel: "Bid Board Sync",
    actorType: "system" as const,
    action: "update",
    entityType: "deal",
    entityName: `Deal ${id}`,
    entitySecondaryId: `DFW-${id}`,
    occurredAt: `2026-05-15T16:03:${String(id).padStart(2, "0")}.000Z`,
    summary: null,
    fieldChanges: [],
    visibilityScope: "internal" as const,
    actorSystemProcess: "Bid Board Sync",
    recordId: `deal-${id}`,
    ...overrides,
  };
}

describe("audit activity feed batch grouping", () => {
  it("collapses 10 consecutive Bid Board Sync rows within the gap into one group", () => {
    const rows = Array.from({ length: 10 }, (_, index) =>
      makeAuditRow({ id: index + 1, occurredAt: `2026-05-15T16:03:${String(index).padStart(2, "0")}.000Z` })
    );

    const grouped = groupAuditLogRows(rows, { minGroupSize: 5, maxGapSeconds: 120 });

    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({
      type: "group",
      processName: "Bid Board Sync",
      totalCount: 10,
      distinctEntityCount: 10,
    });
  });

  it("does not collapse four rows below the group threshold", () => {
    const rows = Array.from({ length: 4 }, (_, index) => makeAuditRow({ id: index + 1 }));

    const grouped = groupAuditLogRows(rows, { minGroupSize: 5, maxGapSeconds: 120 });

    expect(grouped).toHaveLength(4);
    expect(grouped.every((entry) => entry.type === "single")).toBe(true);
  });

  it("splits the same system process when the time gap is too large", () => {
    const firstCycle = Array.from({ length: 6 }, (_, index) =>
      makeAuditRow({ id: index + 1, occurredAt: `2026-05-15T16:03:${String(index).padStart(2, "0")}.000Z` })
    );
    const secondCycle = Array.from({ length: 6 }, (_, index) =>
      makeAuditRow({ id: index + 10, occurredAt: `2026-05-15T16:15:${String(index).padStart(2, "0")}.000Z` })
    );

    const grouped = groupAuditLogRows([...secondCycle, ...firstCycle], { minGroupSize: 5, maxGapSeconds: 120 });

    expect(grouped).toHaveLength(2);
    expect(grouped.every((entry) => entry.type === "group")).toBe(true);
    expect(grouped.map((entry) => entry.type === "group" ? entry.totalCount : 0)).toEqual([6, 6]);
  });

  it("keeps user-driven rows individual while grouping surrounding system rows", () => {
    const systemRows = Array.from({ length: 6 }, (_, index) => makeAuditRow({ id: index + 1 }));
    const userRow = makeAuditRow({
      id: 99,
      actorLabel: "Adnaan Iqbal",
      actorType: "user",
      actorSystemProcess: null,
      occurredAt: "2026-05-15T16:03:03.500Z",
    });

    const grouped = groupAuditLogRows([...systemRows.slice(0, 3), userRow, ...systemRows.slice(3)], {
      minGroupSize: 5,
      maxGapSeconds: 120,
    });

    expect(grouped).toHaveLength(7);
    expect(grouped.some((entry) => entry.type === "group")).toBe(false);
    expect(grouped.filter((entry) => entry.type === "single" && entry.actorType === "user")).toHaveLength(1);
  });

  it("does not group mixed actions or entity types under a misleading label", () => {
    const dealUpdates = Array.from({ length: 3 }, (_, index) =>
      makeAuditRow({ id: index + 1, action: "update", entityType: "deal" })
    );
    const leadCreates = Array.from({ length: 3 }, (_, index) =>
      makeAuditRow({ id: index + 10, action: "insert", entityType: "lead" })
    );

    const grouped = groupAuditLogRows([...dealUpdates, ...leadCreates], { minGroupSize: 5, maxGapSeconds: 120 });

    expect(grouped).toHaveLength(6);
    expect(grouped.some((entry) => entry.type === "group")).toBe(false);
  });
});
