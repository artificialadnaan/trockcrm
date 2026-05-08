import { describe, expect, it, vi } from "vitest";

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

vi.mock("../../../src/db.js", () => ({
  db: createChainableMock([]),
}));

const getMyCleanupQueueMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/modules/admin/cleanup-queue-service.js", () => ({
  getMyCleanupQueue: getMyCleanupQueueMock,
}));

vi.mock("../../../src/modules/migration/service.js", () => ({
  getMigrationSummary: vi.fn().mockResolvedValue({
    deals: {},
    contacts: {},
    activities: {},
    companies: {},
    properties: {},
    leads: {},
    recentRuns: [],
  }),
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

function repSnapshot(overrides: Record<string, unknown>) {
  return {
    rep_id: "rep-a",
    rep_name: "Rep A",
    period_kind: "mtd",
    period_start: "2026-05-01",
    period_end: "2026-05-07",
    pipeline_value: "0",
    closed_value: "0",
    deals_count: "0",
    wins_count: "0",
    losses_count: "0",
    win_rate: "0",
    avg_days_to_close: "0",
    at_risk_count: "0",
    activity_total: "0",
    calls: "0",
    emails: "0",
    meetings: "0",
    notes: "0",
    sparkline_8w: [],
    region: null,
    computed_at: "2026-05-07T12:00:00.000Z",
    previous_closed_value: null,
    ...overrides,
  };
}

describe("director strategic win-rate alerts", () => {
  it("only flags low win rate when closed outcomes exist", async () => {
    const { getDirectorDashboard } = await import("../../../src/modules/dashboard/service.js");
    const tenantDb = {
      execute: vi.fn().mockImplementation((query: unknown) => {
        const text = extractSqlText(query).toLowerCase();

        if (text.includes("from public.rep_performance_snapshots")) {
          return Promise.resolve({
            rows: [
              repSnapshot({
                rep_id: "rep-a",
                rep_name: "Rep A",
                deals_count: "5",
                wins_count: "0",
                losses_count: "0",
                win_rate: "0",
              }),
              repSnapshot({
                rep_id: "rep-b",
                rep_name: "Rep B",
                deals_count: "5",
                wins_count: "1",
                losses_count: "3",
                win_rate: "25",
              }),
              repSnapshot({
                rep_id: "rep-c",
                rep_name: "Rep C",
                deals_count: "5",
                wins_count: "1",
                losses_count: "3",
                win_rate: "24",
              }),
              repSnapshot({
                rep_id: "rep-d",
                rep_name: "Rep D",
                deals_count: "0",
                wins_count: "0",
                losses_count: "0",
                win_rate: "0",
              }),
            ],
          });
        }

        if (text.includes("dd_value") && text.includes("pipeline_value")) {
          return Promise.resolve({
            rows: [{ dd_value: "0", dd_count: "0", pipeline_value: "0", pipeline_count: "0", total_value: "0", total_count: "0" }],
          });
        }

        return Promise.resolve({ rows: [] });
      }),
    } as any;

    const result = await getDirectorDashboard(tenantDb, { from: "2026-05-01", to: "2026-05-07", officeId: "office-1" });

    const winRateAlerts = result.strategicAlerts.filter((alert) => alert.id.startsWith("win-rate-"));
    expect(winRateAlerts.map((alert) => alert.repId)).toEqual(["rep-c"]);
  });
});
