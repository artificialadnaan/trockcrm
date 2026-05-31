import { describe, expect, it, vi } from "vitest";

// SQL-shape guard: proves the canonical Won-date basis is wired into getMarketMixReport
// (quarterly Won value) and getExecutiveTrendsReport (won_fallback CTE), the old contaminated
// COALESCE bases are gone, and the LOST fallback is left untouched.

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
const RANGE = { from: "2026-01-01", to: "2026-12-31" };

describe("analytics-tier4 Won-date basis wired into the live queries", () => {
  it("getMarketMixReport: quarterly Won value windows + buckets by won_closed_date", async () => {
    const { getMarketMixReport } = await import("../../../src/modules/reports/analytics-tier4-service.js");
    const db = createMockTenantDb([[], [], [], [], [], []]);
    await getMarketMixReport(db, RANGE);
    const text = compact(db.execute.mock.calls.map(([q]: [unknown]) => extractSqlText(q)).join("\n"));

    // Quarter is bucketed by the canonical won date, and the outcome window + guard use it too.
    expect(text).toContain("extract(year from d.won_closed_date)");
    expect(text).toContain("extract(quarter from d.won_closed_date)");
    expect(text).toContain("d.won_closed_date is not null");
    expect(text).toContain("d.won_closed_date >=");
    // The old contaminated bases are gone.
    expect(text).not.toContain("coalesce(d.actual_close_date, d.lost_at, d.updated_at)");
    expect(text).not.toContain("coalesce(d.actual_close_date, d.updated_at) at time zone");
  });

  it("getExecutiveTrendsReport: won_fallback on won_closed_date; lost_fallback untouched", async () => {
    const { getExecutiveTrendsReport } = await import("../../../src/modules/reports/analytics-tier4-service.js");
    const db = createMockTenantDb([[], [], [], [], []]);
    await getExecutiveTrendsReport(db, RANGE);
    const text = compact(db.execute.mock.calls.map(([q]: [unknown]) => extractSqlText(q)).join("\n"));

    // won_fallback now buckets/windows by the canonical won date (+ usable-won-date guard).
    expect(text).toContain("to_char(d.won_closed_date, 'yyyy-mm')");
    expect(text).toContain("d.won_closed_date is not null");
    // The old won_fallback basis is gone...
    expect(text).not.toContain("coalesce((d.actual_close_date at time zone 'utc'), d.updated_at)");
    // ...but the lost_fallback basis (lost_at) is intentionally preserved.
    expect(text).toContain("coalesce(d.lost_at, d.updated_at)");
    // won_history stays on the stage-transition axis (not migrated).
    expect(text).toContain("to_char(dsh.created_at at time zone 'utc', 'yyyy-mm')");
  });
});
