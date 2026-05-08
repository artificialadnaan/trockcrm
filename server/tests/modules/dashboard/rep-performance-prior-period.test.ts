import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/db.js", () => ({
  db: {},
}));

const getMyCleanupQueueMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/modules/admin/cleanup-queue-service.js", () => ({
  getMyCleanupQueue: getMyCleanupQueueMock,
}));

vi.mock("../../../src/modules/migration/service.js", () => ({
  getMigrationSummary: vi.fn(),
}));

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

function currentSnapshotRow(overrides: Record<string, unknown>) {
  return {
    rep_id: "rep-1",
    rep_name: "Rep One",
    period_kind: "mtd",
    period_start: "2026-05-01",
    period_end: "2026-05-07",
    pipeline_value: "100",
    closed_value: "100",
    deals_count: "3",
    wins_count: "2",
    losses_count: "1",
    win_rate: "66.67",
    avg_days_to_close: "12",
    at_risk_count: "0",
    activity_total: "10",
    calls: "4",
    emails: "3",
    meetings: "2",
    notes: "1",
    sparkline_8w: [],
    region: null,
    computed_at: "2026-05-07T12:00:00.000Z",
    previous_pipeline_value: null,
    previous_closed_value: null,
    previous_deals_count: null,
    previous_wins_count: null,
    previous_losses_count: null,
    previous_win_rate: null,
    previous_avg_days_to_close: null,
    previous_at_risk_count: null,
    previous_activity_total: null,
    previous_calls: null,
    previous_emails: null,
    previous_meetings: null,
    previous_notes: null,
    ...overrides,
  };
}

describe("rep performance prior-period snapshots", () => {
  it("matches partial prior snapshots by aligned period_end instead of full prior period", async () => {
    const { getRepPerformanceSnapshots } = await import("../../../src/modules/dashboard/service.js");
    const tenantDb = {
      execute: vi.fn().mockResolvedValue({
        rows: [
          currentSnapshotRow({
            previous_closed_value: "80",
            previous_deals_count: "2",
            previous_wins_count: "1",
            previous_losses_count: "1",
            previous_win_rate: "50",
            previous_avg_days_to_close: "10",
            previous_activity_total: "8",
          }),
        ],
      }),
    } as any;

    const result = await getRepPerformanceSnapshots(tenantDb, "office-1", "mtd");
    const queryText = extractSqlText(tenantDb.execute.mock.calls[0][0]).toLowerCase();

    expect(queryText).toContain("prior.period_end =");
    expect(queryText).toContain("current.period_end - interval '1 month'");
    expect(queryText).toContain("current.period_kind = 'mtd'");
    expect(queryText).not.toContain("order by prior.computed_at");
    expect(result.rows[0]?.previous?.closedValue).toBe(80);
    expect(result.rows[0]?.avgDaysToClose).toBe(12);
    expect(result.rows[0]?.previous?.avgDaysToClose).toBe(10);
  });

  it("matches complete prior periods to the actual last day of the prior month/quarter/year", async () => {
    const { getRepPerformanceSnapshots } = await import("../../../src/modules/dashboard/service.js");
    const tenantDb = {
      execute: vi.fn().mockResolvedValue({
        rows: [
          currentSnapshotRow({
            period_kind: "last_month",
            period_start: "2026-04-01",
            period_end: "2026-04-30",
          }),
        ],
      }),
    } as any;

    await getRepPerformanceSnapshots(tenantDb, "office-1", "last_month");
    const queryText = extractSqlText(tenantDb.execute.mock.calls[0][0]).toLowerCase();

    expect(queryText).toContain("current.period_kind = 'last_month'");
    expect(queryText).toContain("date_trunc('month', current.period_end)::date - interval '1 day'");
    expect(queryText).toContain("date_trunc('quarter', current.period_end)::date - interval '1 day'");
    expect(queryText).toContain("date_trunc('year', current.period_end)::date - interval '1 day'");
    expect(queryText).not.toContain("when current.period_kind in ('mtd', 'last_month') then current.period_end - interval '1 month'");
  });
});
