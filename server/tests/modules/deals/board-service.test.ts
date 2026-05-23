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

  return Object.values(value as Record<string, unknown>).map(extractSqlText).join("");
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

function containsIsoDate(value: unknown, expectedDate: string, seen = new Set<unknown>()): boolean {
  if (value instanceof Date) return value.toISOString().startsWith(expectedDate);
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsIsoDate(item, expectedDate, seen));
  return Object.values(value as Record<string, unknown>).some((item) => containsIsoDate(item, expectedDate, seen));
}

vi.mock("../../../src/db.js", () => ({
  db: createChainableMock(),
  pool: {},
}));

describe("getDealsForPipeline", () => {
  beforeEach(() => {
    dbState.responses = [];
  });

  it("returns terminal stage deals while preserving aggregates and preview limits", async () => {
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
    const terminalDeals = Array.from({ length: 8 }).map((_, index) => ({
      id: `deal-won-${index + 1}`,
      dealNumber: `TR-2026-WON-${String(index + 1).padStart(4, "0")}`,
      name: `Won Deal ${index + 1}`,
      stageId: "stage-won",
      assignedRepId: "rep-2",
      officeId: "office-1",
      workflowRoute: "normal",
      awardedAmount: "5000",
      bidEstimate: "5000",
      ddEstimate: null,
      propertyCity: "Dallas",
      propertyState: "TX",
      source: "referral",
      lastActivityAt: "2026-04-21T10:00:00.000Z",
      stageEnteredAt: "2026-04-20T10:00:00.000Z",
      updatedAt: "2026-04-21T10:00:00.000Z",
      companyName: null,
      assignedRepName: "Rep Two",
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
          if (isCardsQuery && isWonQuery) {
            return resolve(terminalDeals);
          }
          if (isWonQuery) {
            return resolve([{ totalCount: 12, activeCount: 10, totalValue: 60000 }]);
          }
          if (isOpportunityQuery) {
            return resolve([{ totalCount: 12, activeCount: 9, totalValue: 12000 }]);
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
      wonSince: "2026-01-01",
    });

    const opportunityCardsChain = findStageCardsChain(tenantChains, "stage-opportunity");
    const wonCardsChain = findStageCardsChain(tenantChains, "stage-won");

    expect(result.pipelineColumns.find((column) => column.stage.slug === "opportunity")?.deals).toHaveLength(8);
    expect(result.pipelineColumns.find((column) => column.stage.slug === "won")?.deals).toHaveLength(8);
    expect(result.terminalStages.find((column) => column.stage.slug === "won")).toEqual({
      stage: expect.objectContaining({ id: "stage-won", slug: "won", name: "Won" }),
      count: 10,
      activeCount: 10,
      totalCount: 12,
      totalValue: 60000,
    });
    expect(opportunityCardsChain?.limit).toHaveBeenCalledWith(8);
    expect(wonCardsChain?.limit).toHaveBeenCalledWith(8);
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
      [{ totalCount: 110, activeCount: 100, totalValue: 110000 }],
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

    expect(result.pipelineColumns[0]?.count).toBe(100);
    expect(result.pipelineColumns[0]?.totalCount).toBe(110);
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

  it("sorts stage previews by created_at desc with an id tiebreaker before preview limiting", async () => {
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

    const tenantChains: any[] = [];
    const tenantDb = {
      select: vi.fn(() => {
        const chain = createChainableMock();
        tenantChains.push(chain);
        chain.then.mockImplementation((resolve: (value: any[]) => unknown) => {
          const isCardsQuery = chain.leftJoin.mock.calls.length > 0;
          return resolve(isCardsQuery ? [] : [{ count: 0, totalValue: 0 }]);
        });
        return chain;
      }),
    } as any;

    const { getDealsForPipeline } = await import("../../../src/modules/deals/service.js");
    await getDealsForPipeline(tenantDb, "director", "director-1", {
      activeOfficeId: null,
      scope: "all",
      previewLimit: 5,
    });

    const cardsChain = findStageCardsChain(tenantChains, "stage-estimating");
    const orderByText = cardsChain?.orderBy.mock.calls.flatMap((call: unknown[]) => call.map(extractSqlText)).join(" ").toLowerCase();
    expect(orderByText).toContain("created_at");
    expect(orderByText).toContain("desc");
    expect(orderByText).toContain("id");
    expect(cardsChain?.limit).toHaveBeenCalledWith(5);
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

  it("hydrates lost terminal cards with date filtering and preview limits", async () => {
    dbState.responses = [
      [
        {
          id: "stage-lost",
          slug: "lost",
          name: "Lost",
          displayOrder: 3,
          isTerminal: true,
          isActivePipeline: true,
        },
      ],
    ];

    const lostDeals = Array.from({ length: 3 }).map((_, index) => ({
      id: `deal-lost-${index + 1}`,
      dealNumber: `TR-2026-LOST-${String(index + 1).padStart(4, "0")}`,
      name: `Lost Deal ${index + 1}`,
      stageId: "stage-lost",
      assignedRepId: "rep-3",
      officeId: "office-1",
      workflowRoute: "normal",
      awardedAmount: "2500",
      bidEstimate: "2500",
      ddEstimate: null,
      propertyCity: "Dallas",
      propertyState: "TX",
      source: "referral",
      lastActivityAt: "2026-04-21T10:00:00.000Z",
      stageEnteredAt: "2026-04-20T10:00:00.000Z",
      updatedAt: "2026-04-21T10:00:00.000Z",
      companyName: null,
      assignedRepName: "Rep Three",
    }));
    const tenantChains: any[] = [];
    const tenantDb = {
      select: vi.fn(() => {
        const chain = createChainableMock();
        tenantChains.push(chain);
        chain.then.mockImplementation((resolve: (value: any[]) => unknown) => {
          const whereClause = chain.where.mock.calls[0]?.[0];
          const isLostQuery = containsValue(whereClause, "stage-lost");
          const isCardsQuery = chain.leftJoin.mock.calls.length > 0;

          if (isCardsQuery && isLostQuery) {
            return resolve(lostDeals);
          }
          if (isLostQuery) {
            return resolve([{ totalCount: 9, activeCount: 9, totalValue: 22500 }]);
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
      previewLimit: 3,
      lostSince: "2026-03-01",
      lostUntil: "2026-03-31",
    });

    const lostCardsChain = findStageCardsChain(tenantChains, "stage-lost");
    const lostSummaryChain = tenantChains.find(
      (chain) =>
        chain.leftJoin.mock.calls.length === 0 &&
        containsValue(chain.where.mock.calls[0]?.[0], "stage-lost")
    );

    expect(result.pipelineColumns.find((column) => column.stage.slug === "lost")?.deals).toHaveLength(3);
    expect(result.terminalStages.find((column) => column.stage.slug === "lost")).toEqual({
      stage: expect.objectContaining({ id: "stage-lost", slug: "lost", name: "Lost" }),
      count: 9,
      activeCount: 9,
      totalCount: 9,
      totalValue: 22500,
    });
    expect(lostCardsChain?.limit).toHaveBeenCalledWith(3);
    expect(containsIsoDate(lostCardsChain?.where.mock.calls[0]?.[0], "2026-03-01")).toBe(true);
    expect(containsIsoDate(lostCardsChain?.where.mock.calls[0]?.[0], "2026-04-01")).toBe(true);
    expect(containsIsoDate(lostSummaryChain?.where.mock.calls[0]?.[0], "2026-03-01")).toBe(true);
    expect(containsIsoDate(lostSummaryChain?.where.mock.calls[0]?.[0], "2026-04-01")).toBe(true);
    expect(extractSqlText(lostCardsChain?.where.mock.calls[0]?.[0])).toContain("lost_at");
    expect(extractSqlText(lostSummaryChain?.where.mock.calls[0]?.[0])).toContain("lost_at");
  });

  it("hydrates won terminal cards with a bounded filter that requires a real signed date", async () => {
    dbState.responses = [
      [
        {
          id: "stage-won",
          slug: "won",
          name: "Won",
          displayOrder: 3,
          isTerminal: true,
          isActivePipeline: true,
        },
      ],
    ];

    const wonDeals = Array.from({ length: 4 }).map((_, index) => ({
      id: `deal-won-${index + 1}`,
      dealNumber: `TR-2026-WON-${String(index + 1).padStart(4, "0")}`,
      name: `Won Deal ${index + 1}`,
      stageId: "stage-won",
      assignedRepId: "rep-4",
      officeId: "office-1",
      workflowRoute: "normal",
      awardedAmount: "4000",
      bidEstimate: "4000",
      ddEstimate: null,
      propertyCity: "Dallas",
      propertyState: "TX",
      source: "referral",
      lastActivityAt: "2026-04-21T10:00:00.000Z",
      stageEnteredAt: "2026-04-20T10:00:00.000Z",
      updatedAt: "2026-04-21T10:00:00.000Z",
      companyName: null,
      assignedRepName: "Rep Four",
    }));
    const tenantChains: any[] = [];
    const tenantDb = {
      select: vi.fn(() => {
        const chain = createChainableMock();
        tenantChains.push(chain);
        chain.then.mockImplementation((resolve: (value: any[]) => unknown) => {
          const whereClause = chain.where.mock.calls[0]?.[0];
          const isWonQuery = containsValue(whereClause, "stage-won");
          const isCardsQuery = chain.leftJoin.mock.calls.length > 0;

          if (isCardsQuery && isWonQuery) {
            return resolve(wonDeals);
          }
          if (isWonQuery) {
            return resolve([{ totalCount: 11, activeCount: 11, totalValue: 44000 }]);
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
      previewLimit: 4,
      wonSince: "2026-03-01",
      wonUntil: "2026-03-31",
    });

    const wonCardsChain = findStageCardsChain(tenantChains, "stage-won");
    const wonSummaryChain = tenantChains.find(
      (chain) =>
        chain.leftJoin.mock.calls.length === 0 &&
        containsValue(chain.where.mock.calls[0]?.[0], "stage-won")
    );

    expect(result.pipelineColumns.find((column) => column.stage.slug === "won")?.deals).toHaveLength(4);
    expect(result.terminalStages.find((column) => column.stage.slug === "won")).toEqual({
      stage: expect.objectContaining({ id: "stage-won", slug: "won", name: "Won" }),
      count: 11,
      activeCount: 11,
      totalCount: 11,
      totalValue: 44000,
    });
    expect(wonCardsChain?.limit).toHaveBeenCalledWith(4);
    expect(containsValue(wonCardsChain?.where.mock.calls[0]?.[0], "2026-03-01")).toBe(true);
    expect(containsValue(wonCardsChain?.where.mock.calls[0]?.[0], "2026-03-31")).toBe(true);
    expect(containsValue(wonSummaryChain?.where.mock.calls[0]?.[0], "2026-03-01")).toBe(true);
    expect(containsValue(wonSummaryChain?.where.mock.calls[0]?.[0], "2026-03-31")).toBe(true);
    expect(extractSqlText(wonCardsChain?.where.mock.calls[0]?.[0])).toContain("contract_signed_at");
    expect(extractSqlText(wonCardsChain?.where.mock.calls[0]?.[0])).toContain("contract_signed_date");
    expect(extractSqlText(wonCardsChain?.where.mock.calls[0]?.[0])).toContain("bid_board_last_updated_at");
    expect(extractSqlText(wonCardsChain?.where.mock.calls[0]?.[0])).not.toContain("stage_entered_at");
    expect(extractSqlText(wonSummaryChain?.where.mock.calls[0]?.[0])).not.toContain("stage_entered_at");
  });

  it("hydrates lost terminal cards with a bounded filter that requires a real lost date", async () => {
    dbState.responses = [
      [
        {
          id: "stage-lost",
          slug: "lost",
          name: "Lost",
          displayOrder: 4,
          isTerminal: true,
          isActivePipeline: true,
        },
      ],
    ];

    const tenantChains: any[] = [];
    const tenantDb = {
      select: vi.fn(() => {
        const chain = createChainableMock();
        tenantChains.push(chain);
        chain.then.mockImplementation((resolve: (value: any[]) => unknown) => resolve(chain.leftJoin.mock.calls.length > 0 ? [] : [{ totalCount: 1, activeCount: 1, totalValue: 5000 }]));
        return chain;
      }),
    } as any;

    const { getDealsForPipeline } = await import("../../../src/modules/deals/service.js");
    await getDealsForPipeline(tenantDb, "director", "director-1", {
      activeOfficeId: null,
      scope: "all",
      lostSince: "2026-03-01",
      lostUntil: "2026-03-31",
    });

    const lostWhereText = tenantChains
      .filter((chain) => containsValue(chain.where.mock.calls[0]?.[0], "stage-lost"))
      .map((chain) => extractSqlText(chain.where.mock.calls[0]?.[0]))
      .join("\n");
    expect(lostWhereText).toContain("lost_at");
    expect(lostWhereText).toContain("bid_board_last_updated_at");
    expect(lostWhereText).not.toContain("stage_entered_at");
  });

  it("keeps won all-time queries free of bounded date predicates", async () => {
    dbState.responses = [
      [
        {
          id: "stage-won",
          slug: "won",
          name: "Won",
          displayOrder: 3,
          isTerminal: true,
          isActivePipeline: true,
        },
      ],
    ];

    const tenantResponses = [
      [{ count: 2, totalValue: 8000 }],
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
      previewLimit: 4,
      wonAllTime: true,
    });

    const wonWhereText = tenantChains
      .filter((chain) => containsValue(chain.where.mock.calls[0]?.[0], "stage-won"))
      .map((chain) => extractSqlText(chain.where.mock.calls[0]?.[0]))
      .join("\n");

    expect(wonWhereText).not.toContain("contract_signed_at");
    expect(wonWhereText).not.toContain("contract_signed_date");
    expect(wonWhereText).not.toContain("bid_board_last_updated_at");
    expect(wonWhereText).not.toContain("stage_entered_at");
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
      execute: vi.fn(async (query?: unknown) => {
        const text = extractSqlText(query).toLowerCase();
        if (text.includes("to_regclass(current_schema()")) {
          return { rows: [{ relation_name: null }] };
        }
        if (text.includes("information_schema.columns")) {
          return { rows: [{ column_exists: false }] };
        }
        return { rows: [] };
      }),
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
    expect(cardsWhere).not.toContain("created_by_user_id");
    expect(cardsWhere).toContain("performed_by_user_id");
    expect(cardsWhere).not.toContain("deal_subscriptions");
  });

  it("keeps all mine-scope pipeline query paths free of subscription-table references", async () => {
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
        {
          id: "stage-won",
          slug: "won",
          name: "Won",
          displayOrder: 2,
          isTerminal: true,
          isActivePipeline: true,
        },
        {
          id: "stage-lost",
          slug: "lost",
          name: "Lost",
          displayOrder: 3,
          isTerminal: true,
          isActivePipeline: true,
        },
      ],
    ];

    const tenantResponses = [
      [{ count: 0, totalValue: 0 }],
      [],
      [{ count: 0, totalValue: 0 }],
      [{ count: 0, totalValue: 0 }],
    ];
    const tenantChains: any[] = [];
    const tenantDb = {
      execute: vi.fn(async (query?: unknown) => {
        const text = extractSqlText(query).toLowerCase();
        if (text.includes("to_regclass(current_schema()")) {
          return { rows: [{ relation_name: null }] };
        }
        if (text.includes("information_schema.columns")) {
          return { rows: [{ column_exists: false }] };
        }
        return { rows: [] };
      }),
      select: vi.fn(() => {
        const chain = createChainableMock();
        tenantChains.push(chain);
        chain.then.mockImplementation((resolve: (value: any[]) => unknown) => resolve(tenantResponses.shift() ?? []));
        return chain;
      }),
    } as any;

    const { getDealsForPipeline } = await import("../../../src/modules/deals/service.js");
    await getDealsForPipeline(tenantDb, "admin", "admin-1", {
      activeOfficeId: null,
      scope: "mine",
      includeDd: true,
      wonAllTime: true,
      lostAllTime: true,
    });

    const allWhereText = tenantChains
      .map((chain) => extractSqlText(chain.where.mock.calls[0]?.[0]).toLowerCase())
      .join("\n");
    expect(allWhereText).not.toContain("deal_subscriptions");
    expect(allWhereText).not.toContain("created_by_user_id");
  });

  it("serializes per-stage mine-scope queries on a single-client tenantDb", async () => {
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
        {
          id: "stage-proposal",
          slug: "proposal",
          name: "Proposal",
          displayOrder: 2,
          isTerminal: false,
          isActivePipeline: true,
        },
      ],
    ];

    let activeSelects = 0;
    let maxConcurrentSelects = 0;
    const tenantDb = {
      execute: vi.fn(async (query?: unknown) => {
        const text = extractSqlText(query).toLowerCase();
        if (text.includes("to_regclass(current_schema()")) {
          return { rows: [{ relation_name: null }] };
        }
        if (text.includes("information_schema.columns")) {
          return { rows: [{ column_exists: false }] };
        }
        return { rows: [] };
      }),
      select: vi.fn(() => {
        const chain = createChainableMock();
        chain.then.mockImplementation(async (resolve: (value: any[]) => unknown) => {
          activeSelects += 1;
          maxConcurrentSelects = Math.max(maxConcurrentSelects, activeSelects);
          await Promise.resolve();
          const whereClause = chain.where.mock.calls[0]?.[0];
          const isEstimatingQuery = containsValue(whereClause, "stage-estimating");
          const isProposalQuery = containsValue(whereClause, "stage-proposal");
          const isCardsQuery = chain.leftJoin.mock.calls.length > 0;
          const response =
            isEstimatingQuery && isCardsQuery
              ? [
                  {
                    id: "deal-1",
                    dealNumber: "TR-2026-0001",
                    name: "Estimating Deal",
                    stageId: "stage-estimating",
                    assignedRepId: "rep-1",
                    officeId: "office-1",
                    workflowRoute: "normal",
                    awardedAmount: null,
                    bidEstimate: "5000",
                    ddEstimate: null,
                    propertyCity: "Dallas",
                    propertyState: "TX",
                    source: "referral",
                    lastActivityAt: "2026-04-21T10:00:00.000Z",
                    stageEnteredAt: "2026-04-20T10:00:00.000Z",
                    updatedAt: "2026-04-21T10:00:00.000Z",
                    companyName: null,
                    assignedRepName: "Rep One",
                  },
                ]
              : isProposalQuery && isCardsQuery
                ? [
                    {
                      id: "deal-2",
                      dealNumber: "TR-2026-0002",
                      name: "Proposal Deal",
                      stageId: "stage-proposal",
                      assignedRepId: "rep-2",
                      officeId: "office-1",
                      workflowRoute: "normal",
                      awardedAmount: null,
                      bidEstimate: "10000",
                      ddEstimate: null,
                      propertyCity: "Dallas",
                      propertyState: "TX",
                      source: "referral",
                      lastActivityAt: "2026-04-21T10:00:00.000Z",
                      stageEnteredAt: "2026-04-20T10:00:00.000Z",
                      updatedAt: "2026-04-21T10:00:00.000Z",
                      companyName: null,
                      assignedRepName: "Rep Two",
                    },
                  ]
                : isEstimatingQuery
                  ? [{ count: 1, totalValue: 5000 }]
                  : isProposalQuery
                    ? [{ count: 2, totalValue: 10000 }]
                    : [];
          activeSelects -= 1;
          return resolve(response);
        });
        return chain;
      }),
    } as any;

    const { getDealsForPipeline } = await import("../../../src/modules/deals/service.js");
    const result = await getDealsForPipeline(tenantDb, "admin", "admin-1", {
      activeOfficeId: null,
      scope: "mine",
      includeDd: true,
    });

    expect(result.pipelineColumns).toHaveLength(2);
    expect(result.pipelineColumns[0]?.deals[0]?.id).toBe("deal-1");
    expect(result.pipelineColumns[1]?.deals[0]?.id).toBe("deal-2");
    expect(maxConcurrentSelects).toBe(1);
  });

  it("layers rep and Estimate Sent date filters into every board stage query", async () => {
    dbState.responses = [
      [
        {
          id: "stage-sent",
          slug: "estimate_sent_to_client",
          name: "Estimate Sent to Client",
          displayOrder: 1,
          isTerminal: false,
          isActivePipeline: true,
        },
        {
          id: "stage-contract",
          slug: "contract",
          name: "Contract",
          displayOrder: 2,
          isTerminal: false,
          isActivePipeline: true,
        },
      ],
    ];

    const tenantChains: any[] = [];
    const tenantDb = {
      select: vi.fn(() => {
        const chain = createChainableMock();
        tenantChains.push(chain);
        chain.then.mockImplementation((resolve: (value: any[]) => unknown) => resolve(chain.leftJoin.mock.calls.length > 0 ? [] : [{ count: 0, totalValue: 0 }]));
        return chain;
      }),
    } as any;

    const { getDealsForPipeline } = await import("../../../src/modules/deals/service.js");
    await getDealsForPipeline(tenantDb, "director", "director-1", {
      activeOfficeId: null,
      scope: "all",
      includeDd: true,
      assignedRepId: "rep-1",
      estimateSentFrom: "2026-04-01",
      estimateSentTo: "2026-04-30",
    });

    const allWhereText = tenantChains
      .map((chain) => extractSqlText(chain.where.mock.calls[0]?.[0]).toLowerCase())
      .join("\n");
    expect(allWhereText).toContain("assigned_rep_id");
    expect(allWhereText).toContain("rep-1");
    expect(allWhereText).toContain("estimate_sent_history_stage");
    expect(allWhereText).toContain("estimate_sent_to_client");
    expect(allWhereText).toContain("service_estimate_sent_to_client");
    expect(allWhereText).toContain("stage_entered_at");
    expect(containsValue(tenantChains.map((chain) => chain.where.mock.calls[0]?.[0]), "2026-04-01")).toBe(true);
    expect(containsValue(tenantChains.map((chain) => chain.where.mock.calls[0]?.[0]), "2026-04-30")).toBe(true);
  });

  it("uses on-hold-aware value SQL for filtered board totals", async () => {
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

    const tenantChains: any[] = [];
    const tenantDb = {
      select: vi.fn((...selectArgs: unknown[]) => {
        const chain = createChainableMock();
        chain._selectArgs = selectArgs;
        tenantChains.push(chain);
        chain.then.mockImplementation((resolve: (value: any[]) => unknown) => {
          const isCardsQuery = chain.leftJoin.mock.calls.length > 0;
          return resolve(isCardsQuery ? [] : [{ count: 2, totalValue: 5000 }]);
        });
        return chain;
      }),
    } as any;

    const { getDealsForPipeline } = await import("../../../src/modules/deals/service.js");
    await getDealsForPipeline(tenantDb, "director", "director-1", {
      activeOfficeId: null,
      scope: "all",
      includeDd: true,
      assignedRepId: "rep-1",
    });

    const summaryChain = tenantChains.find((chain) => chain.leftJoin.mock.calls.length === 0);
    const summarySelect = summaryChain?._selectArgs?.[0] as { totalValue?: unknown } | undefined;
    const summarySelectText = extractSqlText(summarySelect?.totalValue).toLowerCase();
    expect(summarySelectText).toContain("on_hold");
    expect(summarySelectText).toContain("case");
    expect(summarySelectText).toContain("awarded_amount");
    expect(summarySelectText).toContain("bid_estimate");
    expect(summarySelectText).toContain("dd_estimate");
  });

  it("attaches role-relative At Risk results to pipeline deal cards", async () => {
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
      ],
      [
        {
          id: "stage-opportunity",
          slug: "opportunity",
          name: "Opportunity",
          displayOrder: 1,
          isTerminal: false,
          isActivePipeline: true,
        },
      ],
    ];

    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const tenantDb = {
      select: vi.fn(() => {
        const chain = createChainableMock();
        chain.then.mockImplementation((resolve: (value: any[]) => unknown) => {
          const isCardsQuery = chain.leftJoin.mock.calls.length > 0;
          return resolve(
            isCardsQuery
              ? [
                  {
                    id: "deal-1",
                    dealNumber: "TR-2026-0001",
                    name: "Role Relative Deal",
                    stageId: "stage-opportunity",
                    assignedRepId: "rep-1",
                    workflowRoute: "normal",
                    stageEnteredAt: tenDaysAgo,
                    onHold: false,
                    onHoldStartedAt: null,
                    onHoldAccumulatedSeconds: 0,
                    onHoldAccumulatedSecondsAtStageEntry: 0,
                    companyName: null,
                    assignedRepName: "Rep One",
                  },
                ]
              : [{ count: 1, totalValue: 1000 }]
          );
        });
        return chain;
      }),
    } as any;

    const { getDealsForPipeline } = await import("../../../src/modules/deals/service.js");
    const repResult = await getDealsForPipeline(tenantDb, "rep", "rep-1", {
      activeOfficeId: null,
      scope: "all",
    });
    const directorResult = await getDealsForPipeline(tenantDb, "director", "director-1", {
      activeOfficeId: null,
      scope: "all",
    });

    expect(repResult.pipelineColumns[0]?.deals[0]?.atRisk).toMatchObject({
      isAtRisk: true,
      viewerRole: "rep",
      audience: "rep",
      thresholdDays: 7,
      reason: "threshold_reached",
    });
    expect(directorResult.pipelineColumns[0]?.deals[0]?.atRisk).toMatchObject({
      isAtRisk: false,
      viewerRole: "director",
      audience: "leadership",
      thresholdDays: 30,
      reason: "within_sla",
    });
  });

  it("uses hold-aware effective age and terminal-stage exclusions for pipeline At Risk results", async () => {
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

    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    const tenantDb = {
      select: vi.fn(() => {
        const chain = createChainableMock();
        chain.then.mockImplementation((resolve: (value: any[]) => unknown) => {
          const whereClause = chain.where.mock.calls[0]?.[0];
          const isOpportunityQuery = containsValue(whereClause, "stage-opportunity");
          const isWonQuery = containsValue(whereClause, "stage-won");
          const isCardsQuery = chain.leftJoin.mock.calls.length > 0;
          if (!isCardsQuery) return resolve([{ count: 1, totalValue: 1000 }]);
          if (isOpportunityQuery) {
            return resolve([
              {
                id: "deal-hold",
                dealNumber: "TR-2026-HOLD",
                name: "Paused Deal",
                stageId: "stage-opportunity",
                assignedRepId: "rep-1",
                workflowRoute: "normal",
                stageEnteredAt: twentyDaysAgo,
                onHold: true,
                onHoldStartedAt: twentyDaysAgo,
                onHoldAccumulatedSeconds: 0,
                onHoldAccumulatedSecondsAtStageEntry: 0,
                companyName: null,
                assignedRepName: "Rep One",
              },
            ]);
          }
          if (isWonQuery) {
            return resolve([
              {
                id: "deal-won",
                dealNumber: "TR-2026-WON",
                name: "Won Deal",
                stageId: "stage-won",
                bidBoardStageSlug: "opportunity",
                assignedRepId: "rep-1",
                workflowRoute: "normal",
                stageEnteredAt: twentyDaysAgo,
                onHold: false,
                onHoldStartedAt: null,
                onHoldAccumulatedSeconds: 0,
                onHoldAccumulatedSecondsAtStageEntry: 0,
                companyName: null,
                assignedRepName: "Rep One",
              },
            ]);
          }
          return resolve([]);
        });
        return chain;
      }),
    } as any;

    const { getDealsForPipeline } = await import("../../../src/modules/deals/service.js");
    const result = await getDealsForPipeline(tenantDb, "rep", "rep-1", {
      activeOfficeId: null,
      scope: "all",
      wonAllTime: true,
    });

    const holdDeal = result.pipelineColumns
      .find((column) => column.stage.slug === "opportunity")
      ?.deals[0];
    const wonDeal = result.pipelineColumns
      .find((column) => column.stage.slug === "won")
      ?.deals[0];

    expect(holdDeal?.atRisk).toMatchObject({
      isAtRisk: false,
      reason: "on_hold",
      effectiveStageAgeDays: 0,
    });
    expect(wonDeal?.atRisk).toMatchObject({
      isAtRisk: false,
      reason: "terminal_stage",
      canonicalStageSlug: "won",
    });
  });

  it("applies assignedRepId as an additional filter in mine-scope board queries", async () => {
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

    const tenantChains: any[] = [];
    const tenantDb = {
      execute: vi.fn(async (query?: unknown) => {
        const text = extractSqlText(query).toLowerCase();
        if (text.includes("to_regclass(current_schema()")) {
          return { rows: [{ relation_name: null }] };
        }
        if (text.includes("information_schema.columns")) {
          return { rows: [{ column_exists: false }] };
        }
        return { rows: [] };
      }),
      select: vi.fn(() => {
        const chain = createChainableMock();
        tenantChains.push(chain);
        chain.then.mockImplementation((resolve: (value: any[]) => unknown) => resolve(chain.leftJoin.mock.calls.length > 0 ? [] : [{ count: 0, totalValue: 0 }]));
        return chain;
      }),
    } as any;

    const { getDealsForPipeline } = await import("../../../src/modules/deals/service.js");
    await getDealsForPipeline(tenantDb, "admin", "admin-1", {
      activeOfficeId: null,
      scope: "mine",
      includeDd: true,
      assignedRepId: "rep-1",
    });

    const allWhereText = tenantChains
      .map((chain) => extractSqlText(chain.where.mock.calls[0]?.[0]).toLowerCase())
      .join("\n");
    expect(allWhereText).toContain("performed_by_user_id");
    expect(allWhereText).toContain("assigned_rep_id");
    expect(allWhereText).toContain("rep-1");
  });
});
