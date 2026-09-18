import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * The kanban's text search must resolve against EVERY deal in the office, not the card slice.
 *
 * #1074 dropped BOARD_CARDS_PER_STAGE_LIMIT from 1000 to 50 to make the board load fast. The board's
 * search was client-side over `column.cards`, so it silently became "search the top 50 of each column":
 * typing a real project name returned 0/0 across the board while the deal sat in the database and the
 * list below the board found it server-side. That is the regression these tests guard.
 *
 * The predicate is pushed onto `commonConditions`, which is the ONE spine feeding all three queries, so
 * every number the board draws narrows together. Asserting each of the three separately is the point:
 * a search applied to the cards but not the aggregates gives a column reading "0 of 312" above four
 * visible cards — numbers right, board wrong, which is the exact failure shape #1074 already hit once.
 */

const dbState = vi.hoisted(() => ({ stages: [] as any[] }));

function isPipelineStageConfigTable(table: unknown): boolean {
  if (!table || typeof table !== "object") return false;
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name")] === "pipeline_stage_config";
}

function createChainableMock() {
  const chain: any = {
    select: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    leftJoin: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    then: vi.fn((resolve: (value: any[]) => unknown) => resolve(dbState.stages)),
  };
  chain.select.mockReturnValue(chain);
  chain.from.mockImplementation((table: unknown) => {
    if (isPipelineStageConfigTable(table)) {
      chain._isStageConfigQuery = true;
      chain.then.mockImplementation((resolve: (value: any[]) => unknown) => resolve(dbState.stages));
    }
    return chain;
  });
  chain.where.mockReturnValue(chain);
  chain.leftJoin.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  return chain;
}

vi.mock("../../../src/db.js", () => ({ db: createChainableMock(), pool: {} }));

const OPPORTUNITY_STAGE = {
  id: "stage-opportunity",
  slug: "opportunity",
  name: "Opportunity",
  workflowFamily: "standard_deal",
  displayOrder: 1,
  isTerminal: false,
  isActivePipeline: true,
};

const dialect = new PgDialect();
const renderSql = (value: unknown) => dialect.sqlToQuery(value as never).sql.toLowerCase();

/** Deep search a captured WHERE for a bound parameter value. */
function containsValue(value: unknown, expected: string, seen = new Set<unknown>()): boolean {
  if (value === expected) return true;
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsValue(item, expected, seen));
  return Object.values(value as Record<string, unknown>).some((item) =>
    containsValue(item, expected, seen)
  );
}

/** The Pending RFP preview is the only query selecting the `pendingTotalCount` window aggregate. */
function isPendingRfpChain(chain: any): boolean {
  return (chain._selectArgs?.[0] as Record<string, unknown> | undefined)?.pendingTotalCount !== undefined;
}

function buildBoard() {
  const chains: any[] = [];
  const tenantDb = {
    select: vi.fn((...selectArgs: unknown[]) => {
      const chain = createChainableMock();
      chain._selectArgs = selectArgs;
      chains.push(chain);
      chain.then.mockImplementation((resolve: (value: any[]) => unknown) => {
        if (chain._isStageConfigQuery) return resolve(dbState.stages);
        return resolve([]);
      });
      return chain;
    }),
  } as any;
  return { tenantDb, chains };
}

async function runBoard(tenantDb: any, overrides: Record<string, unknown> = {}) {
  const { getDealsForPipeline } = await import("../../../src/modules/deals/service.js");
  return getDealsForPipeline(
    tenantDb,
    "director",
    "director-1",
    {
      scope: "all",
      activeOfficeId: null,
      previewLimit: 50,
      wonAllTime: true,
      lostAllTime: true,
      includeBoardAggregates: true,
      ...overrides,
    },
    "director"
  );
}

/** The cards query is the joined one; the summary is the bare aggregate over `deals`. */
function classifyChains(chains: any[]) {
  const dealChains = chains.filter((chain) => !chain._isStageConfigQuery);
  return {
    cards: dealChains.find((chain) => chain.leftJoin.mock.calls.length > 0 && !isPendingRfpChain(chain)),
    summary: dealChains.find((chain) => chain.leftJoin.mock.calls.length === 0),
    pending: dealChains.find(isPendingRfpChain),
  };
}

describe("getDealsForPipeline — the board's text search runs in SQL, over every matching deal", () => {
  it("applies the search to the CARDS query, so a match ranked below the slice still reaches the board", async () => {
    dbState.stages = [OPPORTUNITY_STAGE];
    const { tenantDb, chains } = buildBoard();

    await runBoard(tenantDb, { search: "belle" });

    const where = classifyChains(chains).cards!.where.mock.calls[0]?.[0];
    // The bound term alone is not the claim — assert the COLUMN too, so a predicate that binds
    // "%belle%" against some other field (or a bare `true`) cannot pass this.
    expect(containsValue(where, "%belle%")).toBe(true);
    expect(renderSql(where)).toContain('"deals"."name" ilike');
  });

  it("applies the SAME search to the column AGGREGATE, so the header count matches the cards", async () => {
    dbState.stages = [OPPORTUNITY_STAGE];
    const { tenantDb, chains } = buildBoard();

    await runBoard(tenantDb, { search: "belle" });

    // A search on the cards but not here is the "0 of 312 above four cards" failure.
    const where = classifyChains(chains).summary!.where.mock.calls[0]?.[0];
    expect(containsValue(where, "%belle%")).toBe(true);
    expect(renderSql(where)).toContain('"deals"."name" ilike');
  });

  it("applies the SAME search to the Pending RFP preview, which is its own query", async () => {
    dbState.stages = [OPPORTUNITY_STAGE];
    const { tenantDb, chains } = buildBoard();

    await runBoard(tenantDb, { search: "belle" });

    const where = classifyChains(chains).pending!.where.mock.calls[0]?.[0];
    expect(containsValue(where, "%belle%")).toBe(true);
    expect(renderSql(where)).toContain('"deals"."name" ilike');
  });

  it("searches the same fields as the list below the board, not just the deal name", async () => {
    dbState.stages = [OPPORTUNITY_STAGE];
    const { tenantDb, chains } = buildBoard();

    await runBoard(tenantDb, { search: "belle" });

    // buildDealSearchCondition is the shared predicate getDeals uses. Reusing it verbatim is what makes
    // the board and the list resolve the same set; a hand-rolled name-only ILIKE here would diverge.
    const text = renderSql(classifyChains(chains).cards!.where.mock.calls[0]?.[0]);
    expect(text).toContain('"deals"."deal_number" ilike');
    expect(text).toContain('"deals"."project_number" ilike');
    expect(text).toContain('"deals"."property_address" ilike');
    expect(text).toContain("companies");
  });

  it("escapes LIKE metacharacters so a literal % cannot widen the match", async () => {
    dbState.stages = [OPPORTUNITY_STAGE];
    const { tenantDb, chains } = buildBoard();

    await runBoard(tenantDb, { search: "100%" });

    const where = classifyChains(chains).cards!.where.mock.calls[0]?.[0];
    expect(containsValue(where, "%100\\%%")).toBe(true);
    expect(renderSql(where)).toContain("escape");
  });

  it("ignores a one-character term, exactly as the deals list does", async () => {
    dbState.stages = [OPPORTUNITY_STAGE];
    const { tenantDb, chains } = buildBoard();

    await runBoard(tenantDb, { search: "b" });

    // getDeals guards at >= 2 chars; a board that narrowed at 1 would disagree with the list below it
    // for one keystroke on every search.
    const where = classifyChains(chains).cards!.where.mock.calls[0]?.[0];
    expect(containsValue(where, "%b%")).toBe(false);
    expect(renderSql(where)).not.toContain("ilike");
  });

  it("ignores a whitespace-only term", async () => {
    dbState.stages = [OPPORTUNITY_STAGE];
    const { tenantDb, chains } = buildBoard();

    await runBoard(tenantDb, { search: "   " });

    expect(renderSql(classifyChains(chains).cards!.where.mock.calls[0]?.[0])).not.toContain("ilike");
  });

  it("adds nothing at all when no search is passed", async () => {
    dbState.stages = [OPPORTUNITY_STAGE];
    const { tenantDb, chains } = buildBoard();

    await runBoard(tenantDb);

    expect(renderSql(classifyChains(chains).cards!.where.mock.calls[0]?.[0])).not.toContain("ilike");
  });
});
