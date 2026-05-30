import { describe, it, expect, vi } from "vitest";

// Wave 1 (P0-1 reconciliation): getCanonicalRepWonSummary is the LIVE per-rep
// decomposition of getWonCloseSummary (the Director "Closed" card). The rep table
// "Closed" column previously read a stale materialized snapshot whose sum diverged
// from the card (YTD/all: card 191/$9,778,045.90 vs snapshot 222/$12,564,603.26).
// By emitting the SAME won-basis predicates as the card and only adding
// `assigned_rep_id` + GROUP BY, SUM(rep rows) == card BY CONSTRUCTION. These tests
// assert that equivalence on the generated SQL (mocked tenantDb), mirroring the
// won-close-hs-date.test.ts harness.

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

function captureExecuteTenantDb(returnRows: any[] = [{ won_count: 0, won_value: 0 }]) {
  const executed: string[] = [];
  const tenantDb = {
    execute: vi.fn().mockImplementation((query?: unknown) => {
      executed.push(extractSqlText(query).toLowerCase());
      return Promise.resolve({ rows: returnRows });
    }),
  } as any;
  return { tenantDb, executed };
}

describe("getCanonicalRepWonSummary (Wave 1 per-rep decomposition of the Closed card)", () => {
  it("emits the SAME won basis as getWonCloseSummary, grouped by assigned_rep_id", async () => {
    const svc = await import("../../../src/modules/dashboard/service.js");
    const range = { from: "2026-01-01", to: "2026-05-31" };

    const cardCap = captureExecuteTenantDb();
    await svc.getWonCloseSummary(cardCap.tenantDb, range);
    const cardSql = cardCap.executed.find((t) => t.includes("won_count")) ?? "";

    const repCap = captureExecuteTenantDb([]);
    await svc.getCanonicalRepWonSummary(repCap.tenantDb, range);
    const repSql = repCap.executed.find((t) => t.includes("won_count")) ?? "";

    // Same won-period basis as the card (so the rows reconcile to it by construction):
    expect(repSql).toContain("won_closed_date"); // flipped basis
    expect(repSql).not.toContain("hs_closed_won_date"); // not the stale HubSpot JSON
    expect(repSql).toContain("is_test_data"); // same test-data exclusion as the card
    expect(repSql).toContain("is not null"); // usable-won-date guard
    expect(repSql).not.toContain("d.updated_at"); // no "touched in-period" fallback
    // Card has these basis tokens; the rep query must too:
    for (const token of ["won_closed_date", "is_test_data", ">=", "<="]) {
      expect(cardSql).toContain(token);
      expect(repSql).toContain(token);
    }
    // The ONLY material addition is the per-rep partition:
    expect(repSql).toContain("group by");
    expect(repSql).toContain("assigned_rep_id");
    // The card itself must NOT be grouped (it is the scalar total):
    expect(cardSql).not.toContain("group by");
  });

  it("aggregates execute rows into per-rep { repId, closedValue, winsCount }", async () => {
    const svc = await import("../../../src/modules/dashboard/service.js");
    const { tenantDb } = captureExecuteTenantDb([
      { rep_id: "rep-1", won_count: 3, won_value: "621952.78" },
      { rep_id: "rep-2", won_count: 1, won_value: 5833.33 },
    ]);

    const rows = await svc.getCanonicalRepWonSummary(tenantDb, { from: "2026-01-01", to: "2026-05-31" });

    expect(rows).toEqual([
      { repId: "rep-1", closedValue: 621952.78, winsCount: 3 },
      { repId: "rep-2", closedValue: 5833.33, winsCount: 1 },
    ]);
  });
});
