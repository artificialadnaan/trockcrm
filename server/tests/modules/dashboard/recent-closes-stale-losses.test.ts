import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/db.js", () => {
  const chain = {
    select() {
      return this;
    },
    from() {
      return this;
    },
    where() {
      return this;
    },
    orderBy() {
      return this;
    },
    then(resolve: (value: unknown) => void) {
      resolve([]);
    },
  };

  return {
    db: chain,
  };
});

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

describe("director recent closes stale losses", () => {
  beforeEach(() => {
    getMyCleanupQueueMock.mockReset();
    getMyCleanupQueueMock.mockResolvedValue({ rows: [], byReason: [] });
  });

  it("uses lost_at before updated_at for lost deal closed_at filtering and display", async () => {
    const { getDirectorDashboard } = await import("../../../src/modules/dashboard/service.js");
    const executedSql: string[] = [];
    const tenantDb = {
      execute: vi.fn().mockImplementation((query: unknown) => {
        const text = extractSqlText(query).toLowerCase();
        executedSql.push(text);

        if (text.includes("closed_at") && text.includes("from")) {
          return Promise.resolve({
            rows: [
              {
                deal_id: "deal-won-today",
                deal_number: "D-100",
                deal_name: "Won today",
                rep_id: "rep-1",
                rep_name: "Rep One",
                outcome: "won",
                deal_value: "100000",
                closed_at: "2026-05-07",
              },
            ],
          });
        }

        return Promise.resolve({ rows: [] });
      }),
    } as any;

    const result = await getDirectorDashboard(tenantDb, {
      from: "2026-04-07",
      to: "2026-05-07",
    });

    const recentCloseSql = executedSql.find((text) => text.includes("closed_at"));
    expect(recentCloseSql).toBeDefined();

    expect(recentCloseSql).toContain(
      "coalesce(d.actual_close_date, d.contract_signed_date, d.contract_signed_at::date, d.lost_at::date, d.updated_at::date) as closed_at"
    );
    expect(recentCloseSql).toContain(
      "coalesce(d.actual_close_date, d.contract_signed_date, d.contract_signed_at::date, d.lost_at::date, d.updated_at::date) >="
    );
    expect(recentCloseSql).toContain(
      "coalesce(d.actual_close_date, d.contract_signed_date, d.contract_signed_at::date, d.lost_at::date, d.updated_at::date) <="
    );
    expect(result.recentCloses).toEqual([
      expect.objectContaining({
        dealId: "deal-won-today",
        outcome: "won",
        closedAt: "2026-05-07",
      }),
    ]);
  });
});
