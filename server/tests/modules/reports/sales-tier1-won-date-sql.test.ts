import { describe, expect, it, vi } from "vitest";

// SQL-shape guard: proves FIX-2 (terminalOutcomeDateSql WON arm) and FIX-4 (topDeals wonAt
// display) are wired into the live getClosedWonRevenueReport queries, and that the LOST arm
// is left untouched.

function createMockTenantDb(rows: any[][] = []) {
  const queue = [...rows];
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

const compact = (value: string) => value.toLowerCase().replace(/\s+/g, " ");

describe("sales-tier1 Won-date basis wired into getClosedWonRevenueReport", () => {
  it("WON arm uses canonical won_closed_date; LOST arm unchanged; topDeals wonAt canonical", async () => {
    const { getClosedWonRevenueReport } = await import("../../../src/modules/reports/sales-tier1-service.js");
    const db = createMockTenantDb([[], [], [], [], [], []]);
    await getClosedWonRevenueReport(
      db,
      {
        dateFrom: "2026-01-01",
        dateTo: "2026-12-31",
        officeSlug: undefined,
        ownerIds: [],
        ownerNames: [],
        ownerEmails: [],
      },
      "won-date-sales-tier1-wiring",
    );
    const text = compact(db.execute.mock.calls.map(([q]: [unknown]) => extractSqlText(q)).join("\n"));

    // FIX-2: the WON (ELSE) arm of terminalOutcomeDateSql now resolves to the canonical column.
    expect(text).toContain("else d.won_closed_date::timestamptz");
    // PR-E: LOST arm now uses the canonical lost_at, falling back to the legacy actual_close_date /
    // stage_entered_at only for older lost deals whose lost_at was never stamped.
    expect(text).toContain("coalesce(d.lost_at, d.actual_close_date::timestamptz, d.stage_entered_at)");
    // FIX-4: the top-Won-deals display date is the canonical won date (matches its selection basis).
    expect(text).toContain('d.won_closed_date::date::text as "wonat"');
    // The legacy WON-window tail is gone (no contract_signed_at/updated_at fallback in the won arm).
    expect(text).not.toContain("coalesce(d.contract_signed_at, d.actual_close_date::timestamptz, d.stage_entered_at, d.updated_at)");
  });
});
