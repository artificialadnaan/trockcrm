import { describe, expect, it, vi } from "vitest";

// Item 3 — B2 Leaderboard reconciliation BASIS alignment. getWonCloseSummary / getCanonicalRepWonSummary
// feed the showcase B2 Won numbers; the Deals Dashboard Won column requires `is_active = true`
// (deals/service.ts ~2827) but these two Won-summary helpers did not. We add `d.is_active = true` so the
// predicate byte-matches the dashboard (numerically a no-op today — 0 soft-deleted Won in prod — but it
// guarantees future reconciliation). This locks the predicate in at the SQL-string level (no-DB capture).

// Chainable Drizzle mock for the public-schema `db` import (mirrors dashboard-rep-ytd-mtd.test.ts).
function createChainableMock(resolveValue: any[] = []) {
  const chain: any = {
    select: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    then: vi.fn((resolve: any) => resolve(resolveValue)),
  };
  chain.select.mockReturnValue(chain);
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  return chain;
}

vi.mock("../src/db.js", () => ({ db: createChainableMock([]) }));

function createMockTenantDb() {
  return {
    execute: vi.fn().mockResolvedValue({ rows: [] }),
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnValue([]),
  } as any;
}

function extractSqlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (Array.isArray((value as { queryChunks?: unknown[] }).queryChunks)) {
    return (value as { queryChunks: unknown[] }).queryChunks.map(extractSqlText).join("");
  }
  if ("value" in (value as Record<string, unknown>)) {
    const chunkValue = (value as { value: unknown }).value;
    if (Array.isArray(chunkValue)) return chunkValue.map(extractSqlText).join("");
    if (typeof chunkValue === "string") return chunkValue;
  }
  if ("name" in (value as Record<string, unknown>) && typeof (value as { name?: unknown }).name === "string") {
    return (value as { name: string }).name;
  }
  return "";
}

describe("B2 Won-summary basis: is_active = true (reconciles to Deals Dashboard Won column)", () => {
  it("getWonCloseSummary requires d.is_active = true", async () => {
    const { getWonCloseSummary } = await import("../src/modules/dashboard/service.js");
    const tenantDb = createMockTenantDb();
    await getWonCloseSummary(tenantDb, { from: "2026-06-01", to: "2026-06-16" });
    const sql = extractSqlText(tenantDb.execute.mock.calls[0][0]).toLowerCase();
    expect(sql).toContain("d.is_active = true");
    // sanity: still the canonical won_closed_date period basis
    expect(sql).toContain("won_closed_date");
  });

  it("getCanonicalRepWonSummary requires d.is_active = true", async () => {
    const { getCanonicalRepWonSummary } = await import("../src/modules/dashboard/service.js");
    const tenantDb = createMockTenantDb();
    await getCanonicalRepWonSummary(tenantDb, { from: "2026-06-01", to: "2026-06-16" });
    const sql = extractSqlText(tenantDb.execute.mock.calls[0][0]).toLowerCase();
    expect(sql).toContain("d.is_active = true");
    expect(sql).toContain("group by d.assigned_rep_id");
  });
});
