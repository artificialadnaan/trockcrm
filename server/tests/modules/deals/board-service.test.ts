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

function findStageCardsChain(chains: any[], stageId: string) {
  return chains.find(
    (chain) =>
      chain.leftJoin.mock.calls.length > 0 &&
      containsValue(chain.where.mock.calls[0]?.[0], stageId)
  );
}

function containsValue(value: unknown, expected: string, seen = new Set<unknown>()): boolean {
  if (value === expected) return true;
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsValue(item, expected, seen));
  return Object.values(value as Record<string, unknown>).some((item) => containsValue(item, expected, seen));
}

vi.mock("../../../src/db.js", () => ({
  db: createChainableMock(),
  pool: {},
}));

describe("getDealsForPipeline", () => {
  beforeEach(() => {
    dbState.responses = [];
  });

  it("returns aggregate-only terminal stages while preserving preview limits for active pipeline columns", async () => {
    dbState.responses = [
      [
        {
          id: "stage-opportunity",
          slug: "opportunity",
          name: "Opportunity",
          displayOrder: 1,
          isTerminal: false,
          isActivePipeline: true,
        },
        {
          id: "stage-won",
          slug: "won",
          name: "Won",
          displayOrder: 2,
          isTerminal: true,
          isActivePipeline: true,
        },
      ],
    ];

    const nonTerminalDeals = Array.from({ length: 8 }).map((_, index) => ({
      id: `deal-open-${index + 1}`,
      dealNumber: `TR-2026-OPEN-${String(index + 1).padStart(4, "0")}`,
      name: `Open Deal ${index + 1}`,
      stageId: "stage-opportunity",
      assignedRepId: "rep-1",
      officeId: "office-1",
      workflowRoute: "normal",
      awardedAmount: null,
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
    const tenantChains: any[] = [];
    const tenantDb = {
      select: vi.fn(() => {
        const chain = createChainableMock();
        tenantChains.push(chain);
        chain.then.mockImplementation((resolve: (value: any[]) => unknown) => {
          const whereClause = chain.where.mock.calls[0]?.[0];
          const isOpportunityQuery = containsValue(whereClause, "stage-opportunity");
          const isWonQuery = containsValue(whereClause, "stage-won");
          const isCardsQuery = chain.leftJoin.mock.calls.length > 0;

          if (isCardsQuery && isOpportunityQuery) {
            return resolve(nonTerminalDeals);
          }
          if (isWonQuery) {
            return resolve([{ count: 12, totalValue: 60000 }]);
          }
          if (isOpportunityQuery) {
            return resolve([{ count: 12, totalValue: 12000 }]);
          }

          return resolve([]);
        });
        return chain;
      }),
    } as any;

    const { getDealsForPipeline } = await import("../../../src/modules/deals/service.js");
    const result = await getDealsForPipeline(tenantDb, "director", "director-1", {
      activeOfficeId: null,
      scope: "all",
      previewLimit: 8,
      won_since: "2026-01-01",
    });

    const opportunityCardsChain = findStageCardsChain(tenantChains, "stage-opportunity");
    const wonCardsChain = findStageCardsChain(tenantChains, "stage-won");

    expect(result.pipelineColumns.find((column) => column.stage.slug === "opportunity")?.deals).toHaveLength(8);
    expect(result.pipelineColumns.find((column) => column.stage.slug === "won")?.deals).toEqual([]);
    expect(result.terminalStages.find((column) => column.stage.slug === "won")).toEqual({
      stage: expect.objectContaining({ id: "stage-won", slug: "won", name: "Won" }),
      count: 12,
      totalValue: 60000,
    });
    expect(opportunityCardsChain?.limit).toHaveBeenCalledWith(8);
    expect(wonCardsChain).toBeUndefined();
  });

  it("uses the requested drill-down preview limit while keeping the full count", async () => {
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
      stageDeals,
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
      previewLimit: 1000,
    });

    const cardsChain = findStageCardsChain(tenantChains, "stage-estimating");
    const summaryChain = tenantChains.find(
      (chain) =>
        chain.leftJoin.mock.calls.length === 0 &&
        containsValue(chain.where.mock.calls[0]?.[0], "stage-estimating")
    );

    expect(result.pipelineColumns[0]?.count).toBe(110);
    expect(result.pipelineColumns[0]?.deals).toHaveLength(110);
    expect(cardsChain?.limit).toHaveBeenCalledWith(1000);
    const cardsWhere = extractSqlText(cardsChain?.where.mock.calls[0][0]).toLowerCase();
    const summaryWhere = extractSqlText(summaryChain?.where.mock.calls[0][0]).toLowerCase();
    expect(summaryWhere).toContain("bid_board_stage_slug");
    expect(summaryWhere).toContain("not in");
    expect(summaryWhere).toContain("closed_won");
    expect(cardsWhere).toContain("bid_board_stage_slug");
    expect(cardsWhere).toContain("not in");
    expect(cardsWhere).toContain("service_lost");
  });

  it("clamps oversized drill-down preview requests to the server maximum", async () => {
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

    const tenantResponses = [
      [{ count: 1500, totalValue: 1500000 }],
      [],
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
    await getDealsForPipeline(tenantDb, "director", "director-1", {
      activeOfficeId: null,
      scope: "all",
      includeDd: true,
      previewLimit: 5000,
    });

    const cardsChain = findStageCardsChain(tenantChains, "stage-estimating");
    expect(cardsChain?.limit).toHaveBeenCalledWith(1000);
  });

  it("falls back to owner-creator-activity Mine scope when subscription tables are unavailable", async () => {
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

    const tenantResponses = [
      [{ count: 0, totalValue: 0 }],
      [],
    ];
    const tenantChains: any[] = [];
    const tenantDb = {
      execute: vi.fn(async () => ({ rows: [{ relation_name: null }] })),
      select: vi.fn(() => {
        const chain = createChainableMock();
        tenantChains.push(chain);
        chain.then.mockImplementation((resolve: (value: any[]) => unknown) => resolve(tenantResponses.shift() ?? []));
        return chain;
      }),
    } as any;

    const { getDealsForPipeline } = await import("../../../src/modules/deals/service.js");
    const result = await getDealsForPipeline(tenantDb, "admin", "admin-1", {
      activeOfficeId: null,
      scope: "mine",
      includeDd: true,
    });

    const cardsChain = findStageCardsChain(tenantChains, "stage-estimating");
    const cardsWhere = extractSqlText(cardsChain?.where.mock.calls[0][0]).toLowerCase();

    expect(result.pipelineColumns[0]?.deals).toEqual([]);
    expect(cardsWhere).toContain("assigned_rep_id");
    expect(cardsWhere).toContain("created_by_user_id");
    expect(cardsWhere).toContain("performed_by_user_id");
    expect(cardsWhere).not.toContain("deal_subscriptions");
  });
});
