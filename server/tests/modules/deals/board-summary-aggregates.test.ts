import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * The board's At-Risk KPI counts and its synthetic Pending RFP column used to be counted on the CLIENT,
 * from `column.cards` — a LIMITED slice. That was survivable only while the board asked for 1000 cards
 * per column. The moment the slice shrinks, those numbers under-report silently: not a slow dashboard,
 * a confidently WRONG one.
 *
 * These tests are the guard against exactly that regression. Each column here holds far MORE matching
 * rows than the card limit allows, and every assertion is a number that must still reflect ALL of them.
 * If anyone re-derives these aggregates from the truncated card array, the counts collapse to the card
 * limit and these fail.
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

/** Long enough past to blow through every SLA threshold in the policy table. */
const ANCIENT = new Date("2020-01-01T00:00:00.000Z").toISOString();
/** Recent enough to be comfortably inside every threshold. */
const TODAY = new Date().toISOString();

const CARD_LIMIT = 3;

const dialect = new PgDialect();
/** Render a drizzle SQL fragment to text (the table objects are cyclic, so JSON.stringify is out). */
const renderSql = (value: unknown) => dialect.sqlToQuery(value as never).sql.toLowerCase();
/** Deep search a captured WHERE for a bound parameter value. */
function containsValue(value: unknown, expected: string, seen = new Set<unknown>()): boolean {
  if (value === expected) return true;
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsValue(item, expected, seen));
  return Object.values(value as Record<string, unknown>).some((item) => containsValue(item, expected, seen));
}

interface RowOptions {
  atRisk?: boolean;
  service?: boolean;
  pendingRfp?: boolean;
  onHold?: boolean;
  value?: string;
}

function summaryRow(index: number, options: RowOptions = {}) {
  return {
    id: `deal-${index}`,
    stageId: OPPORTUNITY_STAGE.id,
    workflowRoute: "normal",
    bidBoardStageSlug: null,
    bidBoardStageEnteredAt: null,
    isBidBoardOwned: false,
    stageEnteredAt: options.atRisk === false ? TODAY : ANCIENT,
    onHold: options.onHold === true,
    onHoldStartedAt: null,
    onHoldAccumulatedSeconds: 0,
    onHoldAccumulatedSecondsAtStageEntry: 0,
    expectedCloseDate: null,
    bidDueDate: null,
    awardedAmount: null,
    ddEstimate: null,
    bidEstimate: options.value ?? "1000",
    bidBoardTotalSales: null,
    isChangeOrder: false,
    // The service/non-service split reads the CONFIGURED project-type digit first; 4 is the service code.
    projectType: null,
    projectTypeCode: options.service ? "4" : "1",
    rfpApprovalStatus: options.pendingRfp ? "pending" : null,
    rfpOverrideDecision: null,
    rfpOverrideState: null,
  };
}

/** The Pending RFP preview is the only query selecting the `pendingTotalCount` window aggregate. */
function isPendingRfpChain(chain: any): boolean {
  return (chain._selectArgs?.[0] as Record<string, unknown> | undefined)?.pendingTotalCount !== undefined;
}

function buildBoard(
  summaryRows: any[],
  aggregates: { totalCount: number; activeCount: number; totalValue: number },
  pending?: {
    rows: any[];
    pendingTotalCount: number;
    pendingActiveCount: number;
    pendingTotalValue: number;
  }
) {
  const chains: any[] = [];
  const decorated = summaryRows.map((row) => ({ ...row, ...aggregates }));
  // Window aggregates are evaluated BEFORE LIMIT, so the real query returns the FULL bucket totals on
  // every one of the (capped) preview rows. The mock reproduces that: totals independent of row count.
  const pendingDecorated = (pending?.rows ?? []).map((row) => ({
    ...row,
    pendingTotalCount: pending?.pendingTotalCount ?? 0,
    pendingActiveCount: pending?.pendingActiveCount ?? 0,
    pendingTotalValue: pending?.pendingTotalValue ?? 0,
  }));
  const tenantDb = {
    select: vi.fn((...selectArgs: unknown[]) => {
      const chain = createChainableMock();
      chain._selectArgs = selectArgs;
      chains.push(chain);
      chain.then.mockImplementation((resolve: (value: any[]) => unknown) => {
        if (chain._isStageConfigQuery) return resolve(dbState.stages);
        if (isPendingRfpChain(chain)) return resolve(pendingDecorated.slice(0, CARD_LIMIT));
        // The CARDS query is the joined one, and it is the ONLY thing the preview limit applies to.
        if (chain.leftJoin.mock.calls.length > 0) return resolve(decorated.slice(0, CARD_LIMIT));
        return resolve(decorated);
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
      previewLimit: CARD_LIMIT,
      wonAllTime: true,
      lostAllTime: true,
      // The web board opts in; every assertion in this file is about that contract.
      includeBoardAggregates: true,
      ...overrides,
    },
    "director"
  );
}

describe("getDealsForPipeline — boardSummary counts ALL matching rows, not the card slice", () => {
  it("counts every at-risk deal in the column even though only 3 cards are returned", async () => {
    dbState.stages = [OPPORTUNITY_STAGE];
    // 30 rows: 5 at-risk service, 7 at-risk non-service, 18 comfortably within SLA. Ten times the cards.
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => summaryRow(i, { service: true })),
      ...Array.from({ length: 7 }, (_, i) => summaryRow(100 + i, { service: false })),
      ...Array.from({ length: 18 }, (_, i) => summaryRow(200 + i, { atRisk: false })),
    ];
    const { tenantDb } = buildBoard(rows, { totalCount: 30, activeCount: 30, totalValue: 30000 });

    const result = await runBoard(tenantDb);

    const column = result.pipelineColumns.find((c) => c.stage.slug === "opportunity")!;
    // The board still returns only the capped card slice...
    expect(column.deals).toHaveLength(CARD_LIMIT);
    // ...while the at-risk verdict counts are over all 30 rows.
    expect(result.boardSummary.atRiskByStageSlug.opportunity).toEqual({ service: 5, nonService: 7 });
    const total =
      result.boardSummary.atRiskByStageSlug.opportunity.service +
      result.boardSummary.atRiskByStageSlug.opportunity.nonService;
    expect(total).toBe(12);
    // The whole point: 12 > the 3 cards a client could have counted.
    expect(total).toBeGreaterThan(CARD_LIMIT);
  });

  it("buckets at-risk pending-RFP deals under pending_rfp, NOT opportunity", async () => {
    // The stage-scoped `?filter=opportunities` view renders the opportunity column WITHOUT the synthetic
    // pending_rfp one, and its card-derived count never included pending deals. Folding them into the
    // `opportunity` bucket therefore inflated that view's three At-Risk cards while the main board (which
    // sums both) stayed right — a wrong number visible on exactly one route.
    dbState.stages = [OPPORTUNITY_STAGE];
    const rows = [
      summaryRow(1),                                  // at-risk, ordinary opportunity
      summaryRow(2, { pendingRfp: true }),            // at-risk, pending RFP
      summaryRow(3, { pendingRfp: true }),            // at-risk, pending RFP
    ];
    const { tenantDb } = buildBoard(rows, { totalCount: 3, activeCount: 3, totalValue: 3000 });

    const result = await runBoard(tenantDb);

    expect(result.boardSummary.atRiskByStageSlug.opportunity).toEqual({ service: 0, nonService: 1 });
    expect(result.boardSummary.atRiskByStageSlug.pending_rfp).toEqual({ service: 0, nonService: 2 });
    // Summing the rendered columns still gives the whole cohort, so the main board is unchanged.
    const total = Object.values(result.boardSummary.atRiskByStageSlug).reduce(
      (sum, bucket) => sum + bucket.service + bucket.nonService,
      0
    );
    expect(total).toBe(3);
  });

  it("ships the Pending RFP column its OWN card slice, not a carve-out of Opportunity's", async () => {
    // The bug this pins: the client built that column by filtering the Opportunity slice, so with a
    // capped slice every pending deal ranked below the cap vanished — a column whose header said 11
    // rendering 0 cards. It now gets a dedicated preview, capped independently.
    dbState.stages = [OPPORTUNITY_STAGE];
    // Opportunity's own slice is entirely NON-pending, exactly the case that used to starve the column.
    const opportunityRows = Array.from({ length: 40 }, (_, i) => summaryRow(200 + i));
    const pendingRows = Array.from({ length: 11 }, (_, i) => summaryRow(i, { pendingRfp: true }));
    const { tenantDb } = buildBoard(
      opportunityRows,
      { totalCount: 51, activeCount: 49, totalValue: 51000 },
      { rows: pendingRows, pendingTotalCount: 11, pendingActiveCount: 9, pendingTotalValue: 9000 }
    );

    const result = await runBoard(tenantDb);

    // Cards arrive independently of the Opportunity slice, capped at the preview limit.
    expect(result.pendingRfpDeals).toHaveLength(CARD_LIMIT);
    expect(result.pendingRfpDeals.every((deal: any) => deal.rfpApprovalStatus === "pending")).toBe(true);
    // ...and each is decorated the same way a column card is, so the client can render it directly.
    expect(result.pendingRfpDeals[0]).toHaveProperty("atRisk");
    expect(result.pendingRfpDeals[0]).toHaveProperty("stageSlug", "opportunity");
    // Totals come from window aggregates on the same query: ACTIVE count/$ plus the all-rows total that
    // the truncation notice needs as its denominator.
    expect(result.boardSummary.pendingRfp).toEqual({ count: 9, totalCount: 11, totalValue: 9000 });
    expect(result.boardSummary.pendingRfp.totalCount).toBeGreaterThan(CARD_LIMIT);
  });


  it("excludes the Pending RFP bucket from the ordinary Opportunity CARDS query, before the cap", async () => {
    // The client lifts pending deals into the synthetic column, so fetching them into Opportunity's
    // slice and discarding them there spent the cap on cards this column never renders: 50 high-ranked
    // pending deals left the ordinary Opportunity column EMPTY under a correct header count.
    dbState.stages = [OPPORTUNITY_STAGE];
    const { tenantDb, chains } = buildBoard([summaryRow(1)], {
      totalCount: 1,
      activeCount: 1,
      totalValue: 1000,
    });

    await runBoard(tenantDb);

    const cardsChain = chains.find(
      (chain) => !isPendingRfpChain(chain) && chain.leftJoin.mock.calls.length > 0
    );
    const summaryChain = chains.find(
      (chain) => !chain._isStageConfigQuery && !isPendingRfpChain(chain) && chain.leftJoin.mock.calls.length === 0
    );
    const cardsSql = renderSql(cardsChain.where.mock.calls[0]?.[0]);
    const summarySql = renderSql(summaryChain.where.mock.calls[0]?.[0]);

    // The CARDS query carries the exclusion...
    expect(cardsSql).toContain("rfp_approval_status");
    expect(cardsSql).toContain("denial_reconfirmed");
    // ...NULL-safely. A bare NOT(<bucket>) evaluates to NULL for the overwhelming majority of rows
    // (rfp_approval_status IS NULL -> NULL IN (...) -> NULL), which a WHERE treats as false — it would
    // drop every ordinary Opportunity deal instead of just the pending ones.
    expect(cardsSql).toContain("coalesce");
    expect(cardsSql).toContain("= false");

    // ...and the SUMMARY deliberately does NOT: it counts the whole stage, because the client partitions
    // those aggregates itself and that arithmetic is what keeps an older API's fallback correct.
    expect(summarySql).not.toContain("rfp_approval_status");
  });

  it("leaves NON-opportunity columns' card queries untouched by the pending exclusion", async () => {
    // The bucket predicate carries no stage bound, so applying it everywhere would drop an estimating
    // deal that still holds a stale pending status — a row the board renders in Estimating.
    dbState.stages = [
      OPPORTUNITY_STAGE,
      {
        id: "stage-estimating",
        slug: "estimating",
        name: "Estimating",
        workflowFamily: "standard_deal",
        displayOrder: 2,
        isTerminal: false,
        isActivePipeline: true,
      },
    ];
    const { tenantDb, chains } = buildBoard([summaryRow(1)], {
      totalCount: 1,
      activeCount: 1,
      totalValue: 1000,
    });

    await runBoard(tenantDb);

    const estimatingCards = chains.find(
      (chain) =>
        !isPendingRfpChain(chain) &&
        chain.leftJoin.mock.calls.length > 0 &&
        containsValue(chain.where.mock.calls[0]?.[0], "stage-estimating")
    );
    expect(estimatingCards).toBeDefined();
    expect(renderSql(estimatingCards.where.mock.calls[0]?.[0])).not.toContain("rfp_approval_status");
  });

  it("scopes the Pending RFP preview with the SAME conditions as the board columns", async () => {
    // Not an office-wide overlay: a cross-rep column cannot reconcile with a scope-filtered board, which
    // is why the cross-rep version was reverted (PR #834). The preview must carry commonConditions.
    dbState.stages = [OPPORTUNITY_STAGE];
    const { tenantDb, chains } = buildBoard([summaryRow(1)], {
      totalCount: 1,
      activeCount: 1,
      totalValue: 1000,
    });

    await runBoard(tenantDb, { assignedRepId: "rep-77" });

    const pendingChain = chains.find(isPendingRfpChain);
    expect(pendingChain).toBeDefined();
    const where = pendingChain.where.mock.calls[0]?.[0];
    expect(containsValue(where, "rep-77")).toBe(true);
    const text = renderSql(where);
    expect(text).toContain("rfp_approval_status");
    expect(text).toContain("is_bid_board_owned");
    expect(text).toContain("denial_reconfirmed");
    expect(text).toContain("is_test_data");
    // Capped like any other preview — it is a card slice, not the whole bucket.
    expect(pendingChain.limit).toHaveBeenCalledWith(CARD_LIMIT);
  });

  it("never applies the preview limit to the summary query — only to the cards query", async () => {
    dbState.stages = [OPPORTUNITY_STAGE];
    const { tenantDb, chains } = buildBoard([summaryRow(1)], {
      totalCount: 1,
      activeCount: 1,
      totalValue: 1000,
    });

    await runBoard(tenantDb);

    const summaryChain = chains.find(
      (chain) => !chain._isStageConfigQuery && chain.leftJoin.mock.calls.length === 0
    );
    const cardsChain = chains.find((chain) => chain.leftJoin.mock.calls.length > 0);
    expect(summaryChain).toBeDefined();
    expect(cardsChain).toBeDefined();
    // A LIMIT on the summary query is precisely how a truncated aggregate would come back.
    expect(summaryChain.limit).not.toHaveBeenCalled();
    expect(cardsChain.limit).toHaveBeenCalledWith(CARD_LIMIT);
  });

  it("computes the column count/total from SQL window aggregates, not by re-summing rows in JS", async () => {
    dbState.stages = [OPPORTUNITY_STAGE];
    // The rows carry a $1,000 bid each; the SQL aggregate deliberately says something else. The column
    // must report the SQL number — re-summing in JS would drift by cents on numeric money and is exactly
    // what we do not want.
    const rows = Array.from({ length: 4 }, (_, i) => summaryRow(i));
    const { tenantDb, chains } = buildBoard(rows, {
      totalCount: 4,
      activeCount: 3,
      totalValue: 987654.32,
    });

    const result = await runBoard(tenantDb);

    const column = result.pipelineColumns.find((c) => c.stage.slug === "opportunity")!;
    expect(column.totalCount).toBe(4);
    expect(column.activeCount).toBe(3);
    expect(column.count).toBe(3);
    expect(column.totalValue).toBe(987654.32);

    const summaryChain = chains.find(
      (chain) => !chain._isStageConfigQuery && chain.leftJoin.mock.calls.length === 0
    );
    const selected = summaryChain._selectArgs?.[0] as Record<string, unknown>;
    // Window form, so the aggregates ride along with the rows in ONE query per open column rather than
    // costing a second round trip.
    expect(renderSql(selected.totalCount)).toContain("over ()");
    expect(renderSql(selected.activeCount)).toContain("over ()");
    expect(renderSql(selected.totalValue)).toContain("over ()");
  });

  it("keeps TERMINAL columns on the pure aggregate — no row set, no at-risk entry", async () => {
    dbState.stages = [
      OPPORTUNITY_STAGE,
      {
        id: "stage-won",
        slug: "won",
        name: "Won",
        workflowFamily: "standard_deal",
        displayOrder: 9,
        isTerminal: true,
        isActivePipeline: true,
      },
    ];
    const { tenantDb, chains } = buildBoard([summaryRow(1)], {
      totalCount: 1,
      activeCount: 1,
      totalValue: 1000,
    });

    const result = await runBoard(tenantDb);

    // At-risk is not-applicable on a terminal stage, so the Won column contributes no bucket at all.
    expect(result.boardSummary.atRiskByStageSlug.won).toBeUndefined();
    // And the Won summary query stays the plain aggregate — the Won column can hold every deal ever won,
    // which is not a row set worth shipping into the API process.
    const wonSummary = chains.find(
      (chain) =>
        !chain._isStageConfigQuery &&
        chain.leftJoin.mock.calls.length === 0 &&
        containsValue(chain.where.mock.calls[0]?.[0], "stage-won")
    );
    expect(wonSummary).toBeDefined();
    expect(Object.keys(wonSummary._selectArgs?.[0] ?? {})).toEqual([
      "totalCount",
      "activeCount",
      "totalValue",
    ]);
  });
});


describe("getDealsForPipeline — a caller that does NOT opt in pays nothing and sees the old shape", () => {
  /**
   * One PR, two services, deployed at different moments — and it cuts both ways. The reverse of the
   * window already handled: the API deploys first (or a tab stays open across the deploy), so an OLD web
   * bundle talks to a NEW API. That client builds its Pending RFP column ONLY by carving matching cards
   * out of `pipelineColumns` and never reads `pendingRfpDeals`, so excluding those rows unconditionally
   * would leave its column empty. It cannot start sending a flag — hence opt-in, default off.
   *
   * The same default answers mobile-crm, which requests 15 cards, does not declare `boardSummary` in its
   * response type, and would otherwise have paid to materialize the entire open pipeline to get them.
   */
  const runWithoutOptIn = async (tenantDb: any) => {
    const { getDealsForPipeline } = await import("../../../src/modules/deals/service.js");
    return getDealsForPipeline(
      tenantDb,
      "director",
      "director-1",
      { scope: "all", activeOfficeId: null, previewLimit: CARD_LIMIT, wonAllTime: true, lostAllTime: true },
      "director"
    );
  };

  it("does NOT materialize the open-pipeline rows — the summary stays a single aggregate", async () => {
    dbState.stages = [OPPORTUNITY_STAGE];
    const { tenantDb, chains } = buildBoard(
      Array.from({ length: 30 }, (_, i) => summaryRow(i)),
      { totalCount: 30, activeCount: 30, totalValue: 30000 }
    );

    await runWithoutOptIn(tenantDb);

    const summaryChain = chains.find(
      (chain) => !chain._isStageConfigQuery && !isPendingRfpChain(chain) && chain.leftJoin.mock.calls.length === 0
    );
    // The one-row aggregate, exactly as before: three keys, no per-row projection, no window functions.
    expect(Object.keys(summaryChain._selectArgs?.[0] ?? {})).toEqual([
      "totalCount",
      "activeCount",
      "totalValue",
    ]);
    expect(renderSql(summaryChain._selectArgs[0].totalCount)).not.toContain("over ()");
  });

  it("keeps the Pending RFP rows IN the ordinary Opportunity cards, so an old client can carve them out", async () => {
    dbState.stages = [OPPORTUNITY_STAGE];
    const { tenantDb, chains } = buildBoard([summaryRow(1)], {
      totalCount: 1,
      activeCount: 1,
      totalValue: 1000,
    });

    await runWithoutOptIn(tenantDb);

    const cardsChain = chains.find(
      (chain) => !isPendingRfpChain(chain) && chain.leftJoin.mock.calls.length > 0
    );
    // No exclusion: those rows are the only source this client has for its Pending RFP column.
    expect(renderSql(cardsChain.where.mock.calls[0]?.[0])).not.toContain("rfp_approval_status");
  });

  it("issues NO Pending RFP preview query and returns neither new field", async () => {
    dbState.stages = [OPPORTUNITY_STAGE];
    const { tenantDb, chains } = buildBoard([summaryRow(1)], {
      totalCount: 1,
      activeCount: 1,
      totalValue: 1000,
    });

    const result = await runWithoutOptIn(tenantDb);

    expect(chains.some(isPendingRfpChain)).toBe(false);
    // NULL / undefined, never a zeroed summary or an empty array — both would read as real answers.
    expect(result.boardSummary).toBeNull();
    expect(result.pendingRfpDeals).toBeUndefined();
  });
});
