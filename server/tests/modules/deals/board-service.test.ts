import { beforeEach, describe, expect, it, vi } from "vitest";

const dbState = vi.hoisted(() => ({
  responses: [] as any[][],
}));

function createChainableMock() {
  const chain: any = {
    select: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    leftJoin: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    then: vi.fn((resolve: (value: any[]) => unknown) => resolve(dbState.responses.shift() ?? [])),
  };

  chain.select.mockReturnValue(chain);
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.leftJoin.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);

  return chain;
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

vi.mock("../../../src/db.js", () => ({
  db: createChainableMock(),
  pool: {},
}));

describe("getDealsForPipeline", () => {
  beforeEach(() => {
    dbState.responses = [];
  });

  it("limits board payload cards to the preview window while keeping the full count", async () => {
    dbState.responses = [
      [
        {
          id: "stage-estimating",
          slug: "estimating",
          name: "Estimating",
          displayOrder: 1,
          isTerminal: false,
          isActivePipeline: true,
        },
      ],
    ];

    const stageDeals = Array.from({ length: 110 }).map((_, index) => ({
      id: `deal-${index + 1}`,
      dealNumber: `TR-2026-${String(index + 1).padStart(4, "0")}`,
      name: `Deal ${index + 1}`,
      stageId: "stage-estimating",
      assignedRepId: "rep-1",
      officeId: "office-1",
      workflowRoute: "normal",
      awardedAmount: "1000",
      bidEstimate: "1000",
      ddEstimate: null,
      propertyCity: "Dallas",
      propertyState: "TX",
      source: "referral",
      lastActivityAt: "2026-04-21T10:00:00.000Z",
      stageEnteredAt: "2026-04-20T10:00:00.000Z",
      updatedAt: "2026-04-21T10:00:00.000Z",
      companyName: null,
      assignedRepName: "Rep One",
    }));
    const tenantResponses = [
      [{ count: 110, totalValue: 110000 }],
      stageDeals.slice(0, 100),
    ];
    const tenantChains: any[] = [];
    const tenantDb = {
      select: vi.fn(() => {
        const chain = createChainableMock();
        tenantChains.push(chain);
        chain.then.mockImplementation((resolve: (value: any[]) => unknown) => resolve(tenantResponses.shift() ?? []));
        return chain;
      }),
    } as any;

    const { getDealsForPipeline } = await import("../../../src/modules/deals/service.js");
    const result = await getDealsForPipeline(tenantDb, "director", "director-1", {
      activeOfficeId: null,
      scope: "all",
      includeDd: true,
    });

    expect(result.pipelineColumns[0]?.count).toBe(110);
    expect(result.pipelineColumns[0]?.deals).toHaveLength(100);
    const summaryWhere = extractSqlText(tenantChains[0].where.mock.calls[0][0]).toLowerCase();
    const cardsWhere = extractSqlText(tenantChains[1].where.mock.calls[0][0]).toLowerCase();
    expect(summaryWhere).toContain("bid_board_stage_slug");
    expect(summaryWhere).toContain("not in");
    expect(summaryWhere).toContain("closed_won");
    expect(cardsWhere).toContain("bid_board_stage_slug");
    expect(cardsWhere).toContain("not in");
    expect(cardsWhere).toContain("service_lost");
  });
});
