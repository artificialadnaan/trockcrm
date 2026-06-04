import { describe, expect, it, vi } from "vitest";

function createMockTenantDb(rows: any[] = []) {
  const queue = Array.isArray(rows[0]) ? [...(rows as any[][])] : [rows];
  return {
    execute: vi.fn().mockImplementation(async () => ({ rows: queue.shift() ?? [] })),
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

describe("on-hold value basis regressions", () => {
  it("keeps closed-won summary on an awarded-first fallback basis", async () => {
    const { getClosedWonSummary } = await import("../../../src/modules/reports/service.js");
    const tenantDb = createMockTenantDb([[], [], []]);

    await getClosedWonSummary(tenantDb, { from: "2026-01-01", to: "2026-12-31" });

    const queryText = extractSqlText(tenantDb.execute.mock.calls[0][0]).toLowerCase();
    expect(queryText).toContain("awarded_amount");
    expect(queryText).toContain("bid_board_total_sales");
    expect(queryText).toContain("bid_estimate");
    expect(queryText).toContain("dd_estimate");
  });

  it("keeps market-mix won value on an awarded-first fallback basis, windowed on won_closed_date", async () => {
    const { getMarketMixReport } = await import("../../../src/modules/reports/analytics-tier4-service.js");
    const tenantDb = createMockTenantDb([[], [], [], [], [], [], [], [], []]);

    await getMarketMixReport(tenantDb, { from: "2026-01-01", to: "2026-12-31" });

    // Wave-0 CC1: Won value is now computed from the WON cohort (won_closed_date window), not the
    // created_at-windowed total_won_value column. The value basis is still the awarded-first fallback
    // chain (effective Won value), never the best-estimate-first open value.
    const queryText = (tenantDb.execute.mock.calls as unknown[][])
      .map((call) => extractSqlText(call[0]))
      .join("\n")
      .toLowerCase();
    expect(queryText).toContain("won_value");
    expect(queryText).toContain("won_closed_date");
    expect(queryText).toContain("awarded_amount");
    expect(queryText).toContain("bid_board_total_sales");
    expect(queryText).toContain("bid_estimate");
    expect(queryText).toContain("dd_estimate");
  });
});
