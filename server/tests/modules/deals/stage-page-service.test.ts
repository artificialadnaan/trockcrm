import { beforeEach, describe, expect, it, vi } from "vitest";

const dbState = vi.hoisted(() => ({
  responses: [] as any[][],
}));

function createChainableMock() {
  const chain: any = {
    select: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    then: vi.fn((resolve: (value: any[]) => unknown) => resolve(dbState.responses.shift() ?? [])),
  };

  chain.select.mockReturnValue(chain);
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);

  return chain;
}

vi.mock("../../../src/db.js", () => ({
  db: createChainableMock(),
  pool: {},
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

describe("listDealStagePage", () => {
  beforeEach(() => {
    dbState.responses = [];
  });

  it("returns paginated deal rows for one stage with normalized sort", async () => {
    dbState.responses = [
      [{ id: "stage-estimating", slug: "estimating", name: "Estimating", displayOrder: 4, isTerminal: false }],
    ];

    const tenantDb = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [{ total: "26", total_value: "400000" }] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: "deal-26",
              deal_number: "TR-2026-0026",
              name: "North Campus",
              stage_id: "stage-estimating",
              office_id: "office-1",
              awarded_amount: "15000",
              bid_estimate: "15000",
              dd_estimate: null,
              updated_at: "2026-04-21T10:00:00.000Z",
              stage_entered_at: "2026-04-18T10:00:00.000Z",
            },
          ],
        }),
    } as any;

    const { listDealStagePage } = await import("../../../src/modules/deals/service.js");
    const result = await listDealStagePage(tenantDb, {
      role: "admin",
      userId: "admin-1",
      activeOfficeId: "office-1",
      scope: "all",
      stageId: "stage-estimating",
      page: 2,
      pageSize: 25,
      sort: "value_desc",
    } as any);

    expect(result.pagination).toMatchObject({ page: 2, pageSize: 25, total: 26, totalPages: 2 });
    expect(result.rows[0]).toMatchObject({ id: "deal-26", stageId: "stage-estimating" });
  });

  it("orders stage rows by awarded amount when value_desc is requested", async () => {
    dbState.responses = [
      [{ id: "stage-estimating", slug: "estimating", name: "Estimating", displayOrder: 4, isTerminal: false }],
    ];

    const tenantDb = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [{ total: "0", total_value: "0" }] })
        .mockResolvedValueOnce({ rows: [] }),
    } as any;

    const { listDealStagePage } = await import("../../../src/modules/deals/service.js");
    await listDealStagePage(tenantDb, {
      role: "admin",
      userId: "admin-1",
      activeOfficeId: "office-1",
      scope: "all",
      stageId: "stage-estimating",
      page: 1,
      pageSize: 25,
      sort: "value_desc",
    } as any);

    const rowsQueryText = extractSqlText(tenantDb.execute.mock.calls[1][0]).toLowerCase();
    expect(rowsQueryText).toContain("order by");
    expect(rowsQueryText).toContain("awarded_amount");
    expect(rowsQueryText).toContain("desc");
  });
});
