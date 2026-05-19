import { describe, expect, it, vi } from "vitest";

const {
  refreshEntityEmailStats,
  refreshEmailStatsForEmailRecords,
} = await import("../../../src/modules/email/stats-service.js");

function collectSqlText(node: any, seen = new Set<unknown>()): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number" || typeof node === "boolean") return String(node);
  if (typeof node !== "object") return "";
  if (seen.has(node)) return "";
  seen.add(node);

  if (Array.isArray(node)) {
    return node.map((entry) => collectSqlText(entry, seen)).join(" ");
  }

  if ("queryChunks" in node) {
    return collectSqlText((node as { queryChunks?: unknown[] }).queryChunks, seen);
  }

  if ("value" in node) {
    return collectSqlText((node as { value?: unknown }).value, seen);
  }

  return Object.values(node)
    .map((entry) => collectSqlText(entry, seen))
    .join(" ");
}

describe("email stats service", () => {
  it("uses COUNT(e.id) and source_lead_id when recomputing deal email stats", async () => {
    const executedQueries: any[] = [];
    const tenantDb = {
      execute: vi.fn(async (query: any) => {
        executedQueries.push(query);
        return [];
      }),
    };

    await refreshEntityEmailStats(tenantDb as any, "deal", "deal-1");

    expect(executedQueries).toHaveLength(1);
    const rendered = collectSqlText(executedQueries[0]);
    expect(rendered).toContain("source_lead_id");
    expect(rendered).toContain("COUNT");
    expect(rendered).toContain("email_count");
    expect(rendered).not.toContain("sourceLeadId");
  });

  it("dedupes repeated stat targets across imported email records", async () => {
    const executeMock = vi.fn(async () => []);
    const tenantDb = {
      execute: executeMock,
      select: vi.fn((shape?: Record<string, unknown>) => {
        const chain: any = {
          from: vi.fn(() => chain),
          where: vi.fn(() => chain),
          limit: vi.fn(() => chain),
          then(resolve: (value: any) => void) {
            if (shape && "companyId" in shape) resolve([{ companyId: "company-1" }]);
            else resolve([]);
          },
        };
        return chain;
      }),
    };

    const processed = await refreshEmailStatsForEmailRecords(tenantDb as any, [
      {
        assignedEntityType: "deal",
        assignedEntityId: "deal-1",
        dealId: "deal-1",
        contactId: null,
      },
      {
        assignedEntityType: "deal",
        assignedEntityId: "deal-1",
        dealId: "deal-1",
        contactId: null,
      },
    ]);

    expect(processed).toBe(2);
    expect(executeMock).toHaveBeenCalledTimes(2);
  });
});
