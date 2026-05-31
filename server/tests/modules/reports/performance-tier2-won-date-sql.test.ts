import { describe, expect, it, vi } from "vitest";

// SQL-shape guard: proves the canonical Won-date basis is actually WIRED INTO the live
// perf-tier2 report queries (the runtime test exercises the helpers in isolation; this
// asserts getDirectorScorecard / getForecastAccuracyReport emit them). Mirrors the
// mock-tenantDb + extractSqlText harness used by on-hold-count-consistency.test.ts.

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

describe("perf-tier2 Won-date basis is wired into the live report queries", () => {
  it("getDirectorScorecard win-rate CTEs window WON by canonical won_closed_date, LOST unchanged", async () => {
    const { getDirectorScorecard } = await import("../../../src/modules/reports/performance-tier2-service.js");
    const db = createMockTenantDb([[], [], [], [], []]);
    await getDirectorScorecard(
      db,
      { dateFrom: "2026-01-01", dateTo: "2026-12-31", ownerIds: [], ownerNames: [] },
      "won-date-scorecard-wiring",
    );
    const text = compact(db.execute.mock.calls.map(([q]: [unknown]) => extractSqlText(q)).join("\n"));

    // WON side migrated to the canonical column (the protected 191/$9,778,045.90 basis).
    expect(text).toContain("d.won_closed_date is not null");
    expect(text).toContain("d.won_closed_date >=");
    expect(text).toContain("d.won_closed_date <=");
    // LOST/denominator side intentionally left on the legacy window (Lost-unification is out of scope).
    expect(text).toContain("coalesce(d.contract_signed_at, (d.actual_close_date at time zone 'utc'), d.updated_at)");
  });

  it("getForecastAccuracyReport: won_period on canonical basis + month-bucket leads with won_closed_date", async () => {
    const { getForecastAccuracyReport } = await import("../../../src/modules/reports/performance-tier2-service.js");
    const db = createMockTenantDb([[], [], []]);
    await getForecastAccuracyReport(
      db,
      { dateFrom: "2026-01-01", dateTo: "2026-12-31", ownerIds: [], ownerNames: [] },
      "won-date-forecast-wiring",
    );
    const text = compact(db.execute.mock.calls.map(([q]: [unknown]) => extractSqlText(q)).join("\n"));

    // FIX-1 at the won-only forecast call site: canonical window.
    expect(text).toContain("d.won_closed_date is not null");
    expect(text).toContain("d.won_closed_date >=");
    // FIX-3: the monthly trend buckets WON deals by canonical won month (COALESCE leads with it).
    expect(text).toContain(
      "coalesce(d.won_closed_date, d.expected_close_date, d.actual_close_date, d.contract_signed_date, d.updated_at::date)",
    );
    // Codex P2 #1: monthly won_actual now carries the usable-won-date guard too, so it reconciles
    // to the summary's won_period (which excludes null-won-date wins). The guard now appears at least
    // twice — once in the summary won_period, once in the monthly won_actual FILTER.
    expect((text.match(/d\.won_closed_date is not null/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // Codex P2 #2: the fragile months-LEFT-JOIN-deals WHERE is gone, so scoped forecasts never drop a
    // month; scope moved into per-aggregate FILTERs.
    expect(text).not.toContain("d.id is null or");
  });
});
