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

describe("listDealBoard", () => {
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

    const tenantDb = {
      execute: vi.fn().mockResolvedValue({
        rows: Array.from({ length: 10 }).map((_, index) => ({
          id: `deal-${index + 1}`,
          deal_number: `TR-2026-${String(index + 1).padStart(4, "0")}`,
          name: `Deal ${index + 1}`,
          stage_id: "stage-estimating",
          assigned_rep_id: "rep-1",
          office_id: "office-1",
          workflow_route: "estimating",
          awarded_amount: "1000",
          bid_estimate: "1000",
          dd_estimate: null,
          property_city: "Dallas",
          property_state: "TX",
          source: "referral",
          last_activity_at: "2026-04-21T10:00:00.000Z",
          stage_entered_at: "2026-04-20T10:00:00.000Z",
          updated_at: "2026-04-21T10:00:00.000Z",
        })),
      }),
    } as any;

    const { listDealBoard } = await import("../../../src/modules/deals/service.js");
    const result = await listDealBoard(tenantDb, {
      role: "director",
      userId: "director-1",
      activeOfficeId: "office-1",
      scope: "team",
      includeDd: true,
      previewLimit: 8,
    });

    expect(result.columns[0]?.count).toBe(10);
    expect(result.columns[0]?.cards).toHaveLength(8);
  });
});
