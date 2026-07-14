import { beforeEach, describe, expect, it, vi } from "vitest";

const dbState = vi.hoisted(() => ({
  stages: [] as any[],
}));

function createChainableMock(rows: any[] = []) {
  const chain: any = {
    select: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    leftJoin: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    then: vi.fn((resolve: (value: any[]) => unknown) => resolve(rows)),
  };
  chain.select.mockReturnValue(chain);
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.leftJoin.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  return chain;
}

function containsValue(value: unknown, expected: unknown, seen = new Set<unknown>()): boolean {
  if (value === expected) return true;
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsValue(item, expected, seen));
  return Object.values(value as Record<string, unknown>).some((item) => containsValue(item, expected, seen));
}

vi.mock("../../../src/db.js", () => ({
  db: {
    select: vi.fn(() => createChainableMock(dbState.stages)),
  },
  pool: {},
}));

const YTD_NOW = new Date("2026-07-14T12:00:00.000Z");

function buildTenantDb(execute = vi.fn().mockResolvedValue({ rows: [] })) {
  return {
    select: vi.fn(() => {
      const chain = createChainableMock();
      chain.then.mockImplementation((resolve: (value: any[]) => unknown) =>
        resolve(chain.leftJoin.mock.calls.length > 0 ? [] : [{ totalCount: 7, activeCount: 6, totalValue: 123456 }])
      );
      return chain;
    }),
    execute,
  } as any;
}

async function getGlobalYtdBoard(tenantDb: any, overrides: Record<string, unknown> = {}) {
  const { getDealsForPipeline } = await import("../../../src/modules/deals/service.js");
  return getDealsForPipeline(tenantDb, "director", "director-1", {
    scope: "all",
    activeOfficeId: null,
    wonAllTime: true,
    lostAllTime: true,
    wonPeriodFrom: "2026-01-01",
    wonPeriodTo: "2026-07-14",
    now: YTD_NOW,
    ...overrides,
  });
}

describe("main Deals Dashboard Won YTD definition snapshot", () => {
  beforeEach(() => {
    dbState.stages = [
      {
        id: "stage-won",
        slug: "won",
        name: "Won",
        displayOrder: 1,
        isTerminal: true,
        isActivePipeline: true,
        workflowFamily: "standard_deal",
      },
    ];
  });

  it("records the exact all-reps current-YTD Won column", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const tenantDb = buildTenantDb(execute);

    await getGlobalYtdBoard(tenantDb);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(containsValue(execute.mock.calls[0]?.[0], "deals_dashboard.won_ytd")).toBe(true);
    expect(containsValue(execute.mock.calls[0]?.[0], 6)).toBe(true);
    expect(containsValue(execute.mock.calls[0]?.[0], 123456)).toBe(true);
  });

  it("does not let a rep-filtered board overwrite the global metric definition", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const tenantDb = buildTenantDb(execute);

    await getGlobalYtdBoard(tenantDb, { assignedRepId: "rep-1" });

    expect(execute).not.toHaveBeenCalled();
  });

  it("only ignores the migration-not-yet-present PostgreSQL error", async () => {
    const missingFunction = vi.fn().mockRejectedValue({ code: "42883" });
    await expect(getGlobalYtdBoard(buildTenantDb(missingFunction))).resolves.toBeDefined();

    const wrappedMissingFunction = vi.fn().mockRejectedValue({ cause: { code: "42883" } });
    await expect(getGlobalYtdBoard(buildTenantDb(wrappedMissingFunction))).resolves.toBeDefined();

    const unexpectedFailure = vi.fn().mockRejectedValue({ code: "XX000" });
    await expect(getGlobalYtdBoard(buildTenantDb(unexpectedFailure))).rejects.toMatchObject({ code: "XX000" });
  });
});
