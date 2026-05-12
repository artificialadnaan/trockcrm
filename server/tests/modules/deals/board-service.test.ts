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
    const tenantDb = {
      select: vi.fn(() => {
        const chain = createChainableMock();
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
  });
});
