import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deals,
  estimateExtractions,
  estimateExtractionMatches,
  estimateGenerationRuns,
  estimatePricingRecommendations,
  estimateReviewEvents,
  estimateSourceDocuments,
  jobQueue,
} from "@trock-crm/shared/schema";
import { estimatePricingRecommendationOptions } from "../../../../shared/src/schema/tenant/estimate-pricing-recommendation-options.js";

const dealMarketOverrideServiceMocks = vi.hoisted(() => ({
  getDealEffectiveMarketContext: vi.fn(),
}));

vi.mock("../../../src/modules/estimating/deal-market-override-service.js", () => ({
  getDealEffectiveMarketContext: dealMarketOverrideServiceMocks.getDealEffectiveMarketContext,
}));

import { buildRecommendationOptionSet } from "../../../src/modules/estimating/recommendation-option-service.js";
import {
  applyMarketRateAdjustment,
  buildPricingRecommendation,
} from "../../../src/modules/estimating/pricing-service.js";
import { persistPricingRecommendationBundle } from "../../../src/modules/estimating/recommendation-persistence-service.js";
import { buildEstimatingWorkbenchState } from "../../../src/modules/estimating/workbench-service.js";

type StoredRows = {
  documents: any[];
  extractions: any[];
  matches: any[];
  pricing: any[];
  reviewEvents: any[];
  generationRuns: any[];
  dealRows: any[];
  jobs: any[];
  recommendationOptions: any[];
};

function makeMarketContext(input: {
  marketId: string;
  marketName: string;
  marketSlug: string;
  resolutionLevel: "override" | "zip" | "metro" | "state" | "region" | "global_default";
  resolutionSource: { type: "override" | "zip" | "metro" | "state" | "region" | "global"; key: string; marketId: string };
  override?: {
    id: string;
    marketId: string;
    marketName: string;
    marketSlug: string;
    overriddenByUserId: string;
    overrideReason: string | null;
    createdAt: Date;
    updatedAt: Date;
  } | null;
}) {
  return {
    effectiveMarket: {
      id: input.marketId,
      name: input.marketName,
      slug: input.marketSlug,
      type: input.resolutionLevel === "override" ? "metro" : "state",
    },
    resolutionLevel: input.resolutionLevel,
    resolutionSource: input.resolutionSource,
    location: {
      zip: "76102",
      state: "TX",
      regionId: "region-1",
    },
    override: input.override ?? null,
  };
}

function makeMarketAdjustment(input: {
  marketId: string;
  marketName: string;
  marketSlug: string;
  resolutionLevel: "override" | "zip" | "metro" | "state" | "region" | "global_default";
  resolutionSource: { type: "override" | "zip" | "metro" | "state" | "region" | "global"; key: string; marketId: string };
  baselinePrice: number;
  adjustedPrice: number;
  selectedRuleId: string;
}) {
  return {
    market: {
      id: input.marketId,
      name: input.marketName,
      slug: input.marketSlug,
      type: input.resolutionLevel === "override" ? "metro" : "state",
      stateCode: "TX",
      regionId: "region-1",
      isActive: true,
      createdAt: new Date("2026-04-21T00:00:00Z"),
      updatedAt: new Date("2026-04-21T00:00:00Z"),
    },
    resolutionLevel: input.resolutionLevel,
    resolutionSource: input.resolutionSource,
    baselinePrice: input.baselinePrice,
    selectedRule: {
      id: input.selectedRuleId,
    },
    componentAdjustments: [
      {
        component: "labor",
        weight: 0.5,
        baselineAmount: input.baselinePrice * 0.5,
        adjustmentPercent: 10,
        adjustmentAmount: input.adjustedPrice - input.baselinePrice,
        adjustedAmount: input.adjustedPrice * 0.5,
      },
    ],
    adjustedPrice: input.adjustedPrice,
    rationale: {
      resolvedMarket: {
        id: input.marketId,
        name: input.marketName,
        slug: input.marketSlug,
        type: input.resolutionLevel === "override" ? "metro" : "state",
        stateCode: "TX",
        regionId: "region-1",
        isActive: true,
        createdAt: new Date("2026-04-21T00:00:00Z"),
        updatedAt: new Date("2026-04-21T00:00:00Z"),
      },
      resolutionLevel: input.resolutionLevel,
      resolutionSource: input.resolutionSource,
      baselinePrice: input.baselinePrice,
      selectedRuleId: input.selectedRuleId,
      componentAdjustments: [
        {
          component: "labor",
          weight: 0.5,
          baselineAmount: input.baselinePrice * 0.5,
          adjustmentPercent: 10,
          adjustmentAmount: input.adjustedPrice - input.baselinePrice,
          adjustedAmount: input.adjustedPrice * 0.5,
        },
      ],
    },
  } as any;
}

function createIntegrationDb(seed?: Partial<StoredRows>) {
  const rows: StoredRows = {
    documents: seed?.documents ? [...seed.documents] : [],
    extractions: seed?.extractions ? [...seed.extractions] : [],
    matches: seed?.matches ? [...seed.matches] : [],
    pricing: seed?.pricing ? [...seed.pricing] : [],
    reviewEvents: seed?.reviewEvents ? [...seed.reviewEvents] : [],
    generationRuns: seed?.generationRuns ? [...seed.generationRuns] : [],
    dealRows: seed?.dealRows ? [...seed.dealRows] : [],
    jobs: seed?.jobs ? [...seed.jobs] : [],
    recommendationOptions: seed?.recommendationOptions ? [...seed.recommendationOptions] : [],
  };

  let sequence = 1;
  const nextId = (prefix: string) => `${prefix}-${sequence++}`;

  const getTableKey = (table: unknown) => {
    switch (table) {
      case estimateSourceDocuments:
        return "documents";
      case estimateExtractions:
        return "extractions";
      case estimateExtractionMatches:
        return "matches";
      case estimatePricingRecommendations:
        return "pricing";
      case estimateReviewEvents:
        return "reviewEvents";
      case estimateGenerationRuns:
        return "generationRuns";
      case deals:
        return "dealRows";
      case estimatePricingRecommendationOptions:
        return "recommendationOptions";
      case jobQueue:
        return "jobs";
      default:
        return null;
    }
  };

  const getRows = (table: unknown) => {
    const key = getTableKey(table);
    return key ? rows[key] : [];
  };

  const getJoinedRows = (left: unknown, right: unknown) => {
    if (
      (left === estimateExtractionMatches && right === estimateExtractions) ||
      (left === estimateExtractions && right === estimateExtractionMatches)
    ) {
      return rows.matches.map((row) => ({ ...row }));
    }

    if (
      (left === estimatePricingRecommendationOptions && right === estimatePricingRecommendations) ||
      (left === estimatePricingRecommendations && right === estimatePricingRecommendationOptions)
    ) {
      return rows.recommendationOptions.map((row) => ({ ...row }));
    }

    return [];
  };

  const buildQueryResult = (resultRows: any[]) => ({
    orderBy: vi.fn(async () => [...resultRows]),
    limit: vi.fn(async (count: number) => resultRows.slice(0, count)),
  });

  const select = vi.fn(() => ({
    from: vi.fn((table: unknown) => ({
      where: vi.fn(() => buildQueryResult(getRows(table))),
      orderBy: vi.fn(async () => [...getRows(table)]),
      limit: vi.fn(async (count: number) => getRows(table).slice(0, count)),
      innerJoin: vi.fn((joinedTable: unknown) => ({
        where: vi.fn(() => buildQueryResult(getJoinedRows(table, joinedTable))),
        orderBy: vi.fn(async () => [...getJoinedRows(table, joinedTable)]),
        limit: vi.fn(async (count: number) => getJoinedRows(table, joinedTable).slice(0, count)),
      })),
    })),
  }));

  const insert = vi.fn((table: unknown) => ({
    values: (payload: any) => {
      const executeInsert = async () => {
        if (table === estimateExtractionMatches) {
          const record = { id: nextId("match"), ...payload };
          rows.matches.push(record);
          return [record];
        }

        if (table === estimatePricingRecommendations) {
          const record = { id: nextId("rec"), ...payload };
          rows.pricing.push(record);
          return [record];
        }

        if (table === estimatePricingRecommendationOptions) {
          const optionRows = (Array.isArray(payload) ? payload : [payload]).map((row) => ({
            id: row.id ?? nextId("option"),
            ...row,
          }));
          rows.recommendationOptions.push(...optionRows);
          return optionRows;
        }

        if (table === estimateReviewEvents) {
          const record = { id: nextId("evt"), ...payload };
          rows.reviewEvents.push(record);
          return [record];
        }

        if (table === jobQueue) {
          const record = { id: Number(sequence++), ...payload };
          rows.jobs.push(record);
          return [record];
        }

        if (table === estimateGenerationRuns) {
          const record = { id: nextId("run"), ...payload };
          rows.generationRuns.push(record);
          return [record];
        }

        return [];
      };

      return {
        returning: vi.fn(async () => executeInsert()),
        then(resolve: any, reject: any) {
          return executeInsert().then(resolve, reject);
        },
      };
    },
  }));

  const update = vi.fn((table: unknown) => ({
    set: (payload: any) => ({
      where: vi.fn(async () => {
        if (table === estimateExtractions) {
          rows.extractions = rows.extractions.map((row) => ({
            ...row,
            ...payload,
          }));
        } else if (table === estimateGenerationRuns) {
          rows.generationRuns = rows.generationRuns.map((row) => ({
            ...row,
            ...payload,
          }));
        }
      }),
    }),
  }));

  const tenantDb = {
    select,
    insert,
    update,
  } as any;
  const appDb = {
    select,
  } as any;

  return { tenantDb, appDb, rows };
}

async function persistRecommendationForRun(input: {
  tenantDb: any;
  generationRunId: string;
  extractionId: string;
  normalizedIntent: string;
  unit: string;
  quantity: number;
  sourceRowIdentity: string;
  sectionName: string;
  recommendationTotal: number;
  marketAdjustment: ReturnType<typeof makeMarketAdjustment>;
}) {
  const baseline = buildPricingRecommendation({
    quantity: input.quantity,
    catalogBaselinePrice: input.recommendationTotal,
    historicalPrices: [input.recommendationTotal],
    vendorQuotePrice: input.recommendationTotal,
    awardedOutcomeAdjustmentPercent: 0,
    internalAdjustmentPercent: 0,
    regionId: "region-1",
    projectTypeId: "roofing",
  });
  const recommendation = applyMarketRateAdjustment({
    recommendation: baseline,
    marketRateAdjustment: input.marketAdjustment as any,
  });
  const recommendationSet = buildRecommendationOptionSet({
    sectionName: input.sectionName,
    normalizedIntent: input.normalizedIntent,
    sourceRowIdentity: input.sourceRowIdentity,
    candidates: [
      {
        optionLabel: "Catalog item",
        catalogItemId: `catalog-${input.generationRunId}`,
        score: 10,
        historicalSelectionCount: 1,
        unitCompatibilityScore: 5,
        absolutePriceDeviation: 0,
        stableId: `catalog-${input.generationRunId}`,
        evidenceJson: { source: "integration-test" },
      },
    ],
  });

  await persistPricingRecommendationBundle({
    tenantDb: input.tenantDb,
    generationRunId: input.generationRunId,
    extraction: {
      id: input.extractionId,
      dealId: "deal-1",
      projectId: null,
      documentId: "doc-1",
      quantity: input.quantity,
      unit: input.unit,
      sourceType: "extracted",
      normalizedIntent: input.normalizedIntent,
      sourceRowIdentity: input.sourceRowIdentity,
      evidenceText: `${input.sectionName} scope`,
      rawLabel: input.normalizedIntent,
      normalizedLabel: input.normalizedIntent,
    },
    topMatch: {
      catalogItemId: `catalog-${input.generationRunId}`,
      matchScore: 99,
      reasons: { exactNameMatch: true },
      historicalLineItemIds: [`hist-${input.generationRunId}`],
      catalogBaselinePrice: input.recommendationTotal,
    },
    recommendation,
    recommendationSet,
    rationaleJson: recommendationSet.rationaleJson,
  });
}

describe("market-rate estimating integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists market-rate-enriched recommendations and keeps rerun visibility aligned across override refreshes", async () => {
    const autoContext = makeMarketContext({
      marketId: "market-auto",
      marketName: "Texas Auto",
      marketSlug: "tx-auto",
      resolutionLevel: "state",
      resolutionSource: {
        type: "state",
        key: "TX",
        marketId: "market-auto",
      },
    });
    const overrideContext = makeMarketContext({
      marketId: "market-override",
      marketName: "Dallas Override",
      marketSlug: "dfw-override",
      resolutionLevel: "override",
      resolutionSource: {
        type: "override",
        key: "deal-1",
        marketId: "market-override",
      },
      override: {
        id: "override-1",
        marketId: "market-override",
        marketName: "Dallas Override",
        marketSlug: "dfw-override",
        overriddenByUserId: "user-1",
        overrideReason: "storm area",
        createdAt: new Date("2026-04-21T10:00:00Z"),
        updatedAt: new Date("2026-04-21T10:00:00Z"),
      },
    });
    let currentMarketContext = autoContext;
    dealMarketOverrideServiceMocks.getDealEffectiveMarketContext.mockImplementation(async () => currentMarketContext);

    const { tenantDb, appDb, rows } = createIntegrationDb({
      documents: [
        {
          id: "doc-1",
          dealId: "deal-1",
          activeParseRunId: "parse-1",
          ocrStatus: "completed",
          createdAt: new Date("2026-04-21T09:00:00Z"),
        },
      ],
      extractions: [
        {
          id: "ext-1",
          dealId: "deal-1",
          documentId: "doc-1",
          status: "approved",
          quantity: "2",
          unit: "ea",
          divisionHint: "Roofing",
          normalizedLabel: "roof tearoff",
          rawLabel: "Roof tearoff",
          metadataJson: { sourceParseRunId: "parse-1", activeArtifact: true },
          createdAt: new Date("2026-04-21T09:01:00Z"),
        },
      ],
      generationRuns: [
        {
          id: "run-auto",
          dealId: "deal-1",
          status: "completed",
          inputSnapshotJson: {},
          startedAt: new Date("2026-04-21T09:10:00Z"),
          completedAt: new Date("2026-04-21T09:15:00Z"),
          errorSummary: null,
          createdAt: new Date("2026-04-21T09:10:00Z"),
        },
      ],
      dealRows: [
        {
          id: "deal-1",
        },
      ],
    });

    await persistRecommendationForRun({
      tenantDb,
      generationRunId: "run-auto",
      extractionId: "ext-1",
      normalizedIntent: "roofing:tearoff:auto",
      unit: "ea",
      quantity: 2,
      sourceRowIdentity: "roof:auto",
      sectionName: "Roofing",
      recommendationTotal: 100,
      marketAdjustment: makeMarketAdjustment({
        marketId: "market-auto",
        marketName: "Texas Auto",
        marketSlug: "tx-auto",
        resolutionLevel: "state",
        resolutionSource: {
          type: "state",
          key: "TX",
          marketId: "market-auto",
        },
        baselinePrice: 100,
        adjustedPrice: 110,
        selectedRuleId: "rule-auto",
      }),
    });

    const initialState = await buildEstimatingWorkbenchState(tenantDb, "deal-1", {
      appDb,
      officeId: "office-1",
    });

    expect(initialState.marketContext).toMatchObject({
      effectiveMarket: { id: "market-auto" },
      resolutionLevel: "state",
      isOverridden: false,
    });
    expect(initialState.activePricingRunId).toBe("run-auto");
    expect(initialState.rerunStatus).toMatchObject({
      status: "idle",
      rerunRequestId: null,
    });
    expect(initialState.pricingRows).toHaveLength(1);
    expect(initialState.pricingRows[0]).toMatchObject({
      createdByRunId: "run-auto",
      marketRateRationale: expect.objectContaining({
        resolvedMarket: expect.objectContaining({ id: "market-auto" }),
        selectedRuleId: "rule-auto",
      }),
      marketRateContext: expect.objectContaining({
        resolvedMarket: expect.objectContaining({ id: "market-auto" }),
      }),
    });

    currentMarketContext = overrideContext;
    rows.jobs.unshift({
      id: 71,
      officeId: "office-1",
      jobType: "estimate_generation",
      status: "pending",
      payload: {
        dealId: "deal-1",
        officeId: "office-1",
        rerunRequestId: "rerun-override",
        trigger: "deal_market_override",
        reason: "market_override_set",
      },
      createdAt: new Date("2026-04-21T09:20:00Z"),
    });

    const queuedOverrideState = await buildEstimatingWorkbenchState(tenantDb, "deal-1", {
      appDb,
      officeId: "office-1",
    });

    expect(queuedOverrideState.marketContext).toMatchObject({
      effectiveMarket: { id: "market-override" },
      resolutionLevel: "override",
      isOverridden: true,
      override: expect.objectContaining({
        marketId: "market-override",
      }),
    });
    expect(queuedOverrideState.activePricingRunId).toBe("run-auto");
    expect(queuedOverrideState.pricingRows.map((row) => row.createdByRunId)).toEqual(["run-auto"]);
    expect(queuedOverrideState.rerunStatus).toEqual({
      status: "queued",
      rerunRequestId: "rerun-override",
      queueJobId: 71,
      generationRunId: null,
      source: "job_queue",
      errorSummary: null,
    });

    rows.generationRuns.unshift({
      id: "run-override",
      dealId: "deal-1",
      status: "running",
      inputSnapshotJson: { rerunRequestId: "rerun-override" },
      startedAt: new Date("2026-04-21T09:21:00Z"),
      completedAt: null,
      errorSummary: null,
      createdAt: new Date("2026-04-21T09:21:00Z"),
    });

    const runningOverrideState = await buildEstimatingWorkbenchState(tenantDb, "deal-1", {
      appDb,
      officeId: "office-1",
    });

    expect(runningOverrideState.activePricingRunId).toBe("run-auto");
    expect(runningOverrideState.pricingRows.map((row) => row.createdByRunId)).toEqual(["run-auto"]);
    expect(runningOverrideState.rerunStatus).toEqual({
      status: "running",
      rerunRequestId: "rerun-override",
      queueJobId: 71,
      generationRunId: "run-override",
      source: "generation_run",
      errorSummary: null,
    });

    rows.generationRuns[0] = {
      ...rows.generationRuns[0],
      status: "completed",
      completedAt: new Date("2026-04-21T09:24:00Z"),
    };

    await persistRecommendationForRun({
      tenantDb,
      generationRunId: "run-override",
      extractionId: "ext-1",
      normalizedIntent: "roofing:tearoff:override",
      unit: "ea",
      quantity: 2,
      sourceRowIdentity: "roof:override",
      sectionName: "Roofing",
      recommendationTotal: 120,
      marketAdjustment: makeMarketAdjustment({
        marketId: "market-override",
        marketName: "Dallas Override",
        marketSlug: "dfw-override",
        resolutionLevel: "override",
        resolutionSource: {
          type: "override",
          key: "deal-1",
          marketId: "market-override",
        },
        baselinePrice: 120,
        adjustedPrice: 144,
        selectedRuleId: "rule-override",
      }),
    });

    const completedOverrideState = await buildEstimatingWorkbenchState(tenantDb, "deal-1", {
      appDb,
      officeId: "office-1",
    });

    expect(completedOverrideState.activePricingRunId).toBe("run-override");
    expect(completedOverrideState.rerunStatus).toEqual({
      status: "idle",
      rerunRequestId: null,
      queueJobId: null,
      generationRunId: null,
      source: null,
      errorSummary: null,
    });
    expect(completedOverrideState.pricingRows).toHaveLength(1);
    expect(completedOverrideState.pricingRows[0]).toMatchObject({
      createdByRunId: "run-override",
      marketRateRationale: expect.objectContaining({
        resolvedMarket: expect.objectContaining({ id: "market-override" }),
        selectedRuleId: "rule-override",
      }),
    });

    currentMarketContext = autoContext;
    rows.jobs.unshift({
      id: 72,
      officeId: "office-1",
      jobType: "estimate_generation",
      status: "pending",
      payload: {
        dealId: "deal-1",
        officeId: "office-1",
        rerunRequestId: "rerun-clear",
        trigger: "deal_market_override",
        reason: "market_override_cleared",
      },
      createdAt: new Date("2026-04-21T09:30:00Z"),
    });

    const queuedClearState = await buildEstimatingWorkbenchState(tenantDb, "deal-1", {
      appDb,
      officeId: "office-1",
    });

    expect(queuedClearState.marketContext).toMatchObject({
      effectiveMarket: { id: "market-auto" },
      resolutionLevel: "state",
      isOverridden: false,
    });
    expect(queuedClearState.activePricingRunId).toBe("run-override");
    expect(queuedClearState.pricingRows.map((row) => row.createdByRunId)).toEqual(["run-override"]);
    expect(queuedClearState.rerunStatus).toEqual({
      status: "queued",
      rerunRequestId: "rerun-clear",
      queueJobId: 72,
      generationRunId: null,
      source: "job_queue",
      errorSummary: null,
    });

    rows.generationRuns.unshift({
      id: "run-clear",
      dealId: "deal-1",
      status: "completed",
      inputSnapshotJson: { rerunRequestId: "rerun-clear" },
      startedAt: new Date("2026-04-21T09:31:00Z"),
      completedAt: new Date("2026-04-21T09:34:00Z"),
      errorSummary: null,
      createdAt: new Date("2026-04-21T09:31:00Z"),
    });

    await persistRecommendationForRun({
      tenantDb,
      generationRunId: "run-clear",
      extractionId: "ext-1",
      normalizedIntent: "roofing:tearoff:cleared",
      unit: "ea",
      quantity: 2,
      sourceRowIdentity: "roof:cleared",
      sectionName: "Roofing",
      recommendationTotal: 105,
      marketAdjustment: makeMarketAdjustment({
        marketId: "market-auto",
        marketName: "Texas Auto",
        marketSlug: "tx-auto",
        resolutionLevel: "state",
        resolutionSource: {
          type: "state",
          key: "TX",
          marketId: "market-auto",
        },
        baselinePrice: 105,
        adjustedPrice: 115.5,
        selectedRuleId: "rule-auto-restored",
      }),
    });

    const clearedOverrideState = await buildEstimatingWorkbenchState(tenantDb, "deal-1", {
      appDb,
      officeId: "office-1",
    });

    expect(clearedOverrideState.marketContext).toMatchObject({
      effectiveMarket: { id: "market-auto" },
      resolutionLevel: "state",
      isOverridden: false,
    });
    expect(clearedOverrideState.activePricingRunId).toBe("run-clear");
    expect(clearedOverrideState.pricingRows).toHaveLength(1);
    expect(clearedOverrideState.pricingRows[0]).toMatchObject({
      createdByRunId: "run-clear",
      marketRateRationale: expect.objectContaining({
        resolvedMarket: expect.objectContaining({ id: "market-auto" }),
        selectedRuleId: "rule-auto-restored",
      }),
    });
    expect(clearedOverrideState.rerunStatus).toEqual({
      status: "idle",
      rerunRequestId: null,
      queueJobId: null,
      generationRunId: null,
      source: null,
      errorSummary: null,
    });
  });
});
