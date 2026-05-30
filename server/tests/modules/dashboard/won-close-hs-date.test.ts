import { describe, it, expect, vi } from "vitest";

// CHANGE 4 (post-flip basis): the Director closed-period card (getWonCloseSummary)
// gates on the app-owned won_closed_date column (flipped off the HubSpot JSON in
// step D), dropping the updated_at fallback that inflated it by counting "touched
// in-period" deals as "won in-period". It must also stop forcing is_active=true
// (terminal Won legitimately includes inactive, §6.7) and exclude test data. Mocked
// tenantDb — asserts on the generated SQL.

vi.mock("@trock-crm/shared/schema", async () => import("../../../../shared/src/schema/index.js"));
vi.mock("@trock-crm/shared/types", async () => import("../../../../shared/src/types/index.js"));

function extractSqlText(value: unknown, seen = new Set<unknown>()): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (seen.has(value)) return "";
  seen.add(value);
  const node = value as Record<string, unknown>;
  if (Array.isArray((node as { queryChunks?: unknown[] }).queryChunks)) {
    return (node.queryChunks as unknown[]).map((c) => extractSqlText(c, seen)).join("");
  }
  if ("value" in node) {
    const v = node.value;
    if (Array.isArray(v)) return v.map((c) => extractSqlText(c, seen)).join("");
    if (typeof v === "string") return v;
  }
  if (typeof node.name === "string") return node.name as string;
  return Object.values(node).map((c) => extractSqlText(c, seen)).join("");
}

function chainable(resolveValue: any[] = []) {
  const chain: any = {
    select: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    limit: vi.fn(),
    then: vi.fn((resolve: any) => resolve(resolveValue)),
  };
  chain.select.mockReturnValue(chain);
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  return chain;
}

vi.mock("../../../src/db.js", () => ({ db: chainable([]) }));

function captureExecuteTenantDb() {
  const executed: string[] = [];
  const tenantDb = {
    execute: vi.fn().mockImplementation((query?: unknown) => {
      executed.push(extractSqlText(query).toLowerCase());
      return Promise.resolve({ rows: [{ won_count: 0, won_value: 0 }] });
    }),
  } as any;
  return { tenantDb, executed };
}

describe("getWonCloseSummary (Director closed-period card)", () => {
  it("gates on won_closed_date, removes the updated_at/actual_close_date COALESCE, and stops forcing is_active=true", async () => {
    const { tenantDb, executed } = captureExecuteTenantDb();
    const { getWonCloseSummary } = await import("../../../src/modules/dashboard/service.js");

    await getWonCloseSummary(tenantDb, { from: "2026-01-01", to: "2026-05-31" });

    const sql = executed.find((t) => t.includes("won_count")) ?? "";
    expect(sql).toContain("won_closed_date");
    expect(sql).not.toContain("hs_closed_won_date"); // flipped off the HubSpot JSON
    expect(sql).toContain("is not null"); // usable-date guard
    expect(sql).toContain("is_test_data"); // test-data exclusion
    // The old COALESCE date fallbacks are gone. (Bare column names still appear in
    // the FROM table reference, so assert on the d.-prefixed date expressions that
    // only the removed COALESCE used.)
    expect(sql).not.toContain("d.updated_at");
    expect(sql).not.toContain("d.actual_close_date");
    expect(sql).not.toContain("d.contract_signed");
    // §6.7: terminal Won includes inactive — no hard is_active = true gate.
    expect(sql).not.toContain("is_active = true");
  });
});
