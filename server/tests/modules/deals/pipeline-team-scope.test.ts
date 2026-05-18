import { beforeEach, describe, expect, it, vi } from "vitest";
import { deals, userOfficeAccess, users } from "@trock-crm/shared/schema";

const dbState = vi.hoisted(() => ({
  stages: [
    {
      id: "stage-estimating",
      slug: "estimating",
      name: "Estimating",
      displayOrder: 1,
      isTerminal: false,
      isActivePipeline: true,
    },
  ],
}));

vi.mock("@trock-crm/shared/schema", async () => import("../../../../shared/src/schema/index.js"));
vi.mock("@trock-crm/shared/types", async () => import("../../../../shared/src/types/index.js"));
vi.mock("../../../src/db.js", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      then: vi.fn((resolve: (value: unknown[]) => unknown) => resolve(dbState.stages)),
    })),
  },
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

function containsValue(value: unknown, expected: string, seen = new Set<unknown>()): boolean {
  if (value === expected) return true;
  if (value instanceof Date) {
    return value.toISOString().startsWith(expected);
  }
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsValue(item, expected, seen));
  return Object.values(value as Record<string, unknown>).some((item) => containsValue(item, expected, seen));
}

describe("getDealsForPipeline team scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.stages = [
      {
        id: "stage-estimating",
        slug: "estimating",
        name: "Estimating",
        displayOrder: 1,
        isTerminal: false,
        isActivePipeline: true,
      },
    ];
  });

  it("uses direct active reports in the active office for team-scoped board queries", async () => {
    const teamQuery = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ id: "rep-team-1" }, { id: "rep-team-2" }]),
    };
    const accessQuery = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    };
    const dealQuery = {
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    };
    const tenantDb = {
      select: vi.fn((fields?: Record<string, unknown>) => ({
        from: vi.fn((table: unknown) => {
          if (table === users) return teamQuery;
          if (table === userOfficeAccess) return accessQuery;
          if (table === deals) return dealQuery;
          return dealQuery;
        }),
      })),
    } as any;

    const { getDealsForPipeline } = await import("../../../src/modules/deals/service.js");
    await getDealsForPipeline(tenantDb, "director", "director-1", {
      scope: "team",
      activeOfficeId: "office-1",
      includeDd: true,
    });

    expect(tenantDb.select).toHaveBeenCalledWith(expect.objectContaining({ id: expect.anything() }));
    const queryText = extractSqlText(dealQuery.where.mock.calls[0][0]);
    expect(queryText).toContain("assigned_rep_id");
    expect(containsValue(dealQuery.where.mock.calls[0][0], "rep-team-1")).toBe(true);
    expect(containsValue(dealQuery.where.mock.calls[0][0], "rep-team-2")).toBe(true);
  });

  it("getDealsForPipeline returns assignedRepName for cards", async () => {
    let selectedDealFields: Record<string, unknown> | undefined;
    const dealQuery = {
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockImplementation(async () => [
        {
          id: "deal-1",
          stageId: "stage-estimating",
          assignedRepId: "rep-1",
          assignedRepName: selectedDealFields?.assignedRepName ? "Brett Jones" : null,
          awardedAmount: null,
          bidEstimate: "5000",
          ddEstimate: null,
        },
      ]),
    };
    const tenantDb = {
      select: vi.fn((fields?: Record<string, unknown>) => {
        selectedDealFields = fields;
        return {
          from: vi.fn((table: unknown) => {
            if (table === deals) return dealQuery;
            return dealQuery;
          }),
        };
      }),
    } as any;

    const { getDealsForPipeline } = await import("../../../src/modules/deals/service.js");
    const result = await getDealsForPipeline(tenantDb, "admin", "admin-1", {
      scope: "all",
      activeOfficeId: "office-1",
      includeDd: true,
    });

    expect(result.pipelineColumns[0].deals[0]?.assignedRepName).toBe("Brett Jones");
  });

  it("getDealsForPipeline narrows to specific rep when scope=team and assignedRepId both set", async () => {
    const teamQuery = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ id: "rep-team-1" }, { id: "rep-team-2" }]),
    };
    const accessQuery = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    };
    const dealQuery = {
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    };
    const tenantDb = {
      select: vi.fn((fields?: Record<string, unknown>) => ({
        from: vi.fn((table: unknown) => {
          if (table === users && fields && "id" in fields) return teamQuery;
          if (table === userOfficeAccess) return accessQuery;
          if (table === deals) return dealQuery;
          return dealQuery;
        }),
      })),
    } as any;

    const { getDealsForPipeline } = await import("../../../src/modules/deals/service.js");
    await getDealsForPipeline(tenantDb, "director", "director-1", {
      scope: "team",
      assignedRepId: "rep-team-1",
      activeOfficeId: "office-1",
      includeDd: true,
    });

    expect(containsValue(dealQuery.where.mock.calls[0][0], "rep-team-1")).toBe(true);
    expect(containsValue(dealQuery.where.mock.calls[0][0], "rep-team-2")).toBe(false);
  });

  it("preserves inactive terminal history for all-time terminal pipeline columns", async () => {
    dbState.stages = [
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
        displayOrder: 7,
        isTerminal: true,
        isActivePipeline: true,
      },
    ];
    const dealQuery = {
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    };
    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn((table: unknown) => {
          if (table === deals) return dealQuery;
          return dealQuery;
        }),
      })),
    } as any;

    const { getDealsForPipeline } = await import("../../../src/modules/deals/service.js");
    await getDealsForPipeline(tenantDb, "admin", "admin-1", {
      scope: "all",
      activeOfficeId: "office-1",
      includeDd: true,
      wonAllTime: true,
    });

    const terminalWhere = dealQuery.where.mock.calls
      .map((call) => call[0])
      .find((condition) => containsValue(condition, "stage-won"));
    expect(terminalWhere).toBeTruthy();
    expect(extractSqlText(terminalWhere).toLowerCase()).not.toContain("is_active");
  });

  it("applies the card limit only to non-terminal visible stages", async () => {
    dbState.stages = [
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
        displayOrder: 7,
        isTerminal: true,
        isActivePipeline: true,
      },
    ];
    const dealQueries: any[] = [];
    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn((table: unknown) => {
          if (table === deals) {
            const dealQuery = {
              leftJoin: vi.fn().mockReturnThis(),
              where: vi.fn().mockReturnThis(),
              orderBy: vi.fn().mockReturnThis(),
              limit: vi.fn().mockResolvedValue([]),
            };
            dealQueries.push(dealQuery);
            return dealQuery;
          }
          const fallbackQuery = {
            leftJoin: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnThis(),
            orderBy: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue([]),
          };
          dealQueries.push(fallbackQuery);
          return fallbackQuery;
        }),
      })),
    } as any;

    const { getDealsForPipeline } = await import("../../../src/modules/deals/service.js");
    await getDealsForPipeline(tenantDb, "admin", "admin-1", {
      scope: "all",
      activeOfficeId: "office-1",
      includeDd: true,
      wonAllTime: true,
    });

    const cardQueries = dealQueries.filter((query) => query.leftJoin.mock.calls.length > 0);
    const nonTerminalCardsQuery = cardQueries.find((query) =>
      containsValue(query.where.mock.calls[0]?.[0], "stage-estimating")
    );
    const wonCardsQuery = cardQueries.find((query) =>
      containsValue(query.where.mock.calls[0]?.[0], "stage-won")
    );

    expect(nonTerminalCardsQuery?.limit.mock.calls.map((call: [number]) => call[0])).toEqual([100]);
    expect(wonCardsQuery).toBeUndefined();
  });

  it("queries each active won alias terminal column by its own stage when no canonical won stage exists", async () => {
    dbState.stages = [
      {
        id: "stage-sent",
        slug: "sent_to_production",
        name: "Sent to Production",
        displayOrder: 7,
        isTerminal: true,
        isActivePipeline: true,
      },
      {
        id: "stage-closed",
        slug: "closed_won",
        name: "Closed Won",
        displayOrder: 8,
        isTerminal: true,
        isActivePipeline: true,
      },
    ];
    const dealQuery = {
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    };
    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn((table: unknown) => {
          if (table === deals) return dealQuery;
          return dealQuery;
        }),
      })),
    } as any;

    const { getDealsForPipeline } = await import("../../../src/modules/deals/service.js");
    await getDealsForPipeline(tenantDb, "admin", "admin-1", {
      scope: "all",
      activeOfficeId: "office-1",
      includeDd: true,
      wonAllTime: true,
    });

    const sentStageConditions = dealQuery.where.mock.calls
      .map((call) => call[0])
      .filter((condition) => containsValue(condition, "stage-sent"));
    const closedStageConditions = dealQuery.where.mock.calls
      .map((call) => call[0])
      .filter((condition) => containsValue(condition, "stage-closed"));

    expect(sentStageConditions).toHaveLength(1);
    expect(closedStageConditions).toHaveLength(1);
    expect(sentStageConditions.every((condition) => !containsValue(condition, "stage-closed"))).toBe(true);
    expect(closedStageConditions.every((condition) => !containsValue(condition, "stage-sent"))).toBe(true);
  });

  it("includes legacy won alias deals in the canonical won terminal column when aliases also exist", async () => {
    dbState.stages = [
      {
        id: "stage-won",
        slug: "won",
        name: "Won",
        displayOrder: 7,
        isTerminal: true,
        isActivePipeline: true,
      },
      {
        id: "stage-sent",
        slug: "sent_to_production",
        name: "Sent to Production",
        displayOrder: 8,
        isTerminal: true,
        isActivePipeline: false,
      },
    ];
    const dealQuery = {
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    };
    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn((table: unknown) => {
          if (table === deals) return dealQuery;
          return dealQuery;
        }),
      })),
    } as any;

    const { getDealsForPipeline } = await import("../../../src/modules/deals/service.js");
    const result = await getDealsForPipeline(tenantDb, "admin", "admin-1", {
      scope: "all",
      activeOfficeId: "office-1",
      includeDd: true,
      wonAllTime: true,
    });

    expect(result.pipelineColumns.map((column) => column.stage.id)).toEqual(["stage-won"]);
    const canonicalConditions = dealQuery.where.mock.calls
      .map((call) => call[0])
      .filter((condition) => containsValue(condition, "stage-won"));
    expect(canonicalConditions).toHaveLength(1);
    expect(canonicalConditions.every((condition) => containsValue(condition, "stage-sent"))).toBe(true);
  });

  it("intersects won period bounds with the won terminal date filter for terminal aggregates", async () => {
    dbState.stages = [
      {
        id: "stage-won",
        slug: "won",
        name: "Won",
        displayOrder: 7,
        isTerminal: true,
        isActivePipeline: true,
      },
    ];
    const dealQuery = {
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    };
    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn((table: unknown) => {
          if (table === deals) return dealQuery;
          return dealQuery;
        }),
      })),
    } as any;

    const { getDealsForPipeline } = await import("../../../src/modules/deals/service.js");
    await getDealsForPipeline(tenantDb, "admin", "admin-1", {
      scope: "all",
      activeOfficeId: "office-1",
      includeDd: true,
      wonSince: "2026-04-08",
      wonUntil: "2026-05-08",
      wonPeriodFrom: "2026-04-01",
      wonPeriodTo: "2026-04-30",
    });

    const wonConditions = dealQuery.where.mock.calls
      .map((call) => call[0])
      .filter((condition) => containsValue(condition, "stage-won"));

    expect(wonConditions).toHaveLength(1);
    expect(containsValue(wonConditions[0], "2026-04-08")).toBe(true);
    expect(containsValue(wonConditions[0], "2026-05-08")).toBe(true);
    expect(containsValue(wonConditions[0], "2026-04-01")).toBe(true);
    expect(containsValue(wonConditions[0], "2026-04-30")).toBe(true);
    expect(extractSqlText(wonConditions[0])).toContain("contract_signed_at");
    expect(extractSqlText(wonConditions[0])).toContain("contract_signed_date");
    expect(extractSqlText(wonConditions[0])).not.toContain("stage_entered_at");
  });

  it("queries each active lost alias terminal column by its own stage when no canonical lost stage exists", async () => {
    dbState.stages = [
      {
        id: "stage-production-lost",
        slug: "production_lost",
        name: "Production Lost",
        displayOrder: 8,
        isTerminal: true,
        isActivePipeline: true,
      },
      {
        id: "stage-closed-lost",
        slug: "closed_lost",
        name: "Closed Lost",
        displayOrder: 9,
        isTerminal: true,
        isActivePipeline: true,
      },
    ];
    const dealQuery = {
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    };
    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn((table: unknown) => {
          if (table === deals) return dealQuery;
          return dealQuery;
        }),
      })),
    } as any;

    const { getDealsForPipeline } = await import("../../../src/modules/deals/service.js");
    await getDealsForPipeline(tenantDb, "admin", "admin-1", {
      scope: "all",
      activeOfficeId: "office-1",
      includeDd: true,
      lostAllTime: true,
    });

    const productionLostConditions = dealQuery.where.mock.calls
      .map((call) => call[0])
      .filter((condition) => containsValue(condition, "stage-production-lost"));
    const closedLostConditions = dealQuery.where.mock.calls
      .map((call) => call[0])
      .filter((condition) => containsValue(condition, "stage-closed-lost"));

    expect(productionLostConditions).toHaveLength(1);
    expect(closedLostConditions).toHaveLength(1);
    expect(productionLostConditions.every((condition) => !containsValue(condition, "stage-closed-lost"))).toBe(true);
    expect(closedLostConditions.every((condition) => !containsValue(condition, "stage-production-lost"))).toBe(true);
  });

  it("includes legacy lost alias deals in the canonical lost terminal column when aliases also exist", async () => {
    dbState.stages = [
      {
        id: "stage-lost",
        slug: "lost",
        name: "Lost",
        displayOrder: 8,
        isTerminal: true,
        isActivePipeline: true,
      },
      {
        id: "stage-production-lost",
        slug: "production_lost",
        name: "Production Lost",
        displayOrder: 9,
        isTerminal: true,
        isActivePipeline: false,
      },
    ];
    const dealQuery = {
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    };
    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn((table: unknown) => {
          if (table === deals) return dealQuery;
          return dealQuery;
        }),
      })),
    } as any;

    const { getDealsForPipeline } = await import("../../../src/modules/deals/service.js");
    const result = await getDealsForPipeline(tenantDb, "admin", "admin-1", {
      scope: "all",
      activeOfficeId: "office-1",
      includeDd: true,
      lostAllTime: true,
    });

    expect(result.pipelineColumns.map((column) => column.stage.id)).toEqual(["stage-lost"]);
    const canonicalConditions = dealQuery.where.mock.calls
      .map((call) => call[0])
      .filter((condition) => containsValue(condition, "stage-lost"));
    expect(canonicalConditions).toHaveLength(1);
    expect(canonicalConditions.every((condition) => containsValue(condition, "stage-production-lost"))).toBe(true);
  });
});
