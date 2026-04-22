import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deals,
  estimateDealMarketOverrides,
  estimateExtractions,
  estimateExtractionMatches,
  estimateMarketFallbackGeographies,
  estimateGenerationRuns,
  estimateMarkets,
  estimateMarketZipMappings,
  estimatePricingRecommendations,
  estimateReviewEvents,
  estimateSourceDocuments,
  jobQueue,
  properties,
} from "@trock-crm/shared/schema";
import { estimatePricingRecommendationOptions } from "../../../../shared/src/schema/tenant/estimate-pricing-recommendation-options.js";

const dealMarketOverrideServiceMocks = vi.hoisted(() => ({
  getDealEffectiveMarketContext: vi.fn(),
}));

vi.mock("../../../src/modules/estimating/deal-market-override-service.js", () => ({
  getDealEffectiveMarketContext: dealMarketOverrideServiceMocks.getDealEffectiveMarketContext,
}));

import {
  buildEstimatingWorkbenchState,
  updateEstimatePricingRecommendationReviewState,
} from "../../../src/modules/estimating/workbench-service.js";

function getTableKey(table: unknown) {
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
      return "review_events";
    case estimateGenerationRuns:
      return "generation_runs";
    case deals:
      return "deals";
    case properties:
      return "properties";
    case estimateDealMarketOverrides:
      return "deal_market_overrides";
    case estimateMarkets:
      return "estimate_markets";
    case estimateMarketFallbackGeographies:
      return "estimate_market_fallback_geographies";
    case estimateMarketZipMappings:
      return "estimate_market_zip_mappings";
    case estimatePricingRecommendationOptions:
      return "recommendation_options";
    case jobQueue:
      return "job_queue";
    default:
      return "unknown";
  }
}

function makeDb(input: {
  documents?: any[];
  extractions?: any[];
  matches?: any[];
  pricing?: any[];
  reviewEvents?: any[];
  generationRuns?: any[];
  dealRows?: any[];
  propertyRows?: any[];
  overrideRows?: any[];
  fallbackMarketRows?: any[];
  zipMarketRows?: any[];
  recommendationOptions?: any[];
  jobs?: any[];
}) {
  const tableRows = new Map<unknown, any[]>([
    [estimateSourceDocuments, input.documents ?? []],
    [estimateExtractions, input.extractions ?? []],
    [estimatePricingRecommendations, input.pricing ?? []],
    [estimateReviewEvents, input.reviewEvents ?? []],
    [estimateGenerationRuns, input.generationRuns ?? []],
    [deals, input.dealRows ?? []],
    [properties, input.propertyRows ?? []],
    [estimateMarketFallbackGeographies, []],
    [estimateMarketZipMappings, []],
    [estimatePricingRecommendationOptions, input.recommendationOptions ?? []],
    [jobQueue, input.jobs ?? []],
  ]);
  const joinRows = new Map<string, any[]>([
    ["matches:extractions", input.matches ?? []],
    ["deal_market_overrides:estimate_markets", input.overrideRows ?? []],
    ["estimate_market_fallback_geographies:estimate_markets", input.fallbackMarketRows ?? []],
    ["estimate_market_zip_mappings:estimate_markets", input.zipMarketRows ?? []],
  ]);

  const select = vi.fn(() => ({
    from: vi.fn((table: unknown) => {
      const rows = tableRows.get(table) ?? [];
      return {
        where: vi.fn(() => ({
          orderBy: vi.fn().mockResolvedValue(rows),
          limit: vi.fn().mockResolvedValue(rows.slice(0, 1)),
        })),
        orderBy: vi.fn().mockResolvedValue(rows),
        limit: vi.fn().mockResolvedValue(rows.slice(0, 1)),
        innerJoin: vi.fn((joinedTable: unknown) => {
          const rows =
            joinRows.get(`${getTableKey(table)}:${getTableKey(joinedTable)}`) ??
            joinRows.get(`${getTableKey(joinedTable)}:${getTableKey(table)}`) ??
            [];
          return {
            where: vi.fn(() => ({
              orderBy: vi.fn().mockResolvedValue(rows),
              limit: vi.fn().mockResolvedValue(rows.slice(0, 1)),
            })),
            orderBy: vi.fn().mockResolvedValue(rows),
            limit: vi.fn().mockResolvedValue(rows.slice(0, 1)),
          };
        }),
      };
    }),
  }));

  return {
    tenantDb: { select } as any,
    appDb: { select } as any,
  };
}

describe("buildEstimatingWorkbenchState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dealMarketOverrideServiceMocks.getDealEffectiveMarketContext.mockResolvedValue({
      dealId: "deal-1",
      effectiveMarketContext: {
        market: {
          id: "market-default",
          name: "Default Market",
          slug: "default-market",
          type: "global",
        },
        resolutionLevel: "global_default",
        resolutionSource: {
          type: "global",
          key: "default",
          marketId: "market-default",
        },
        location: {
          zip: null,
          state: null,
          regionId: null,
        },
      },
      currentOverride: null,
    });
  });

  it("filters workbench rows to the active parse run before summarizing", async () => {
    const { tenantDb } = makeDb({
      documents: [
        { id: "doc-1", activeParseRunId: "run-1", ocrStatus: "queued" },
        { id: "doc-2", activeParseRunId: "run-2", ocrStatus: "failed" },
      ],
      extractions: [
        {
          id: "ext-1",
          documentId: "doc-1",
          status: "pending",
          metadataJson: { sourceParseRunId: "run-1", activeArtifact: true },
        },
        {
          id: "ext-2",
          documentId: "doc-1",
          status: "approved",
          metadataJson: { sourceParseRunId: "run-1", activeArtifact: true },
        },
        {
          id: "ext-3",
          documentId: "doc-1",
          status: "rejected",
          metadataJson: { sourceParseRunId: "run-old", activeArtifact: false },
        },
        {
          id: "ext-4",
          documentId: "doc-2",
          status: "unmatched",
          metadataJson: { sourceParseRunId: "run-2", activeArtifact: true },
        },
      ],
      matches: [
        { id: "match-1", extractionId: "ext-1", status: "suggested" },
        { id: "match-2", extractionId: "ext-3", status: "selected" },
        { id: "match-3", extractionId: "ext-4", status: "rejected" },
      ],
      pricing: [
        {
          id: "rec-1",
          extractionMatchId: "match-1",
          status: "pending",
          createdByRunId: "run-pending",
        },
        {
          id: "rec-2",
          extractionMatchId: "match-2",
          status: "approved",
          createdByRunId: "run-approved-stale",
        },
        {
          id: "rec-3",
          extractionMatchId: "match-3",
          status: "overridden",
          createdByRunId: "run-approved-active",
        },
      ],
      reviewEvents: [{ id: "event-1" }],
      recommendationOptions: [
        {
          id: "option-1",
          recommendationId: "rec-1",
          optionLabel: "Recommended option",
          optionKind: "recommended",
          rank: 1,
        },
      ],
    });

    const state = await buildEstimatingWorkbenchState(tenantDb, "deal-1");

    expect(state.summary).toEqual({
      documents: {
        total: 2,
        queued: 1,
        failed: 1,
      },
      extractions: {
        total: 3,
        pending: 1,
        approved: 1,
        rejected: 0,
        unmatched: 1,
      },
      matches: {
        total: 2,
        suggested: 1,
        selected: 0,
        rejected: 1,
      },
      pricing: {
        total: 2,
        pending: 1,
        approved: 0,
        overridden: 1,
        rejected: 0,
        readyToPromote: 1,
      },
    });
    expect(state.promotionReadiness).toEqual({
      canPromote: true,
      generationRunIds: ["run-approved-active"],
    });
    expect(state.documents).toHaveLength(2);
    expect(state.extractionRows).toHaveLength(3);
    expect(state.matchRows).toHaveLength(2);
    expect(state.pricingRows).toHaveLength(2);
    expect(state.pricingRows[0]?.recommendationOptions).toEqual([
      expect.objectContaining({
        id: "option-1",
        recommendationId: "rec-1",
      }),
    ]);
  });

  it("exposes market context, fallback metadata, active completed run logic, rerun status, and market-rate rationale", async () => {
    dealMarketOverrideServiceMocks.getDealEffectiveMarketContext.mockResolvedValueOnce({
      dealId: "deal-1",
      effectiveMarketContext: {
        market: {
          id: "market-state",
          name: "Texas",
          slug: "tx",
          type: "state",
        },
        resolutionLevel: "state",
        resolutionSource: {
          type: "state",
          key: "TX",
          marketId: "market-state",
        },
        location: {
          zip: null,
          state: "TX",
          regionId: "region-south",
        },
      },
      currentOverride: null,
    });

    const { tenantDb, appDb } = makeDb({
      documents: [{ id: "doc-1", activeParseRunId: "parse-1", ocrStatus: "completed" }],
      extractions: [
        {
          id: "ext-1",
          documentId: "doc-1",
          status: "approved",
          metadataJson: { sourceParseRunId: "parse-1", activeArtifact: true },
          divisionHint: "Roofing",
        },
      ],
      matches: [{ id: "match-1", extractionId: "ext-1", status: "selected" }],
      pricing: [
        {
          id: "rec-completed",
          extractionMatchId: "match-1",
          status: "approved",
          createdByRunId: "run-completed",
          sourceType: "explicit",
          normalizedIntent: "roofing tearoff",
          sourceRowIdentity: "roof:tearoff-1",
          sectionName: "Roof",
          assumptionsJson: {
            marketRate: {
              resolvedMarket: { id: "market-state", name: "Texas", slug: "tx" },
              resolutionLevel: "state",
              resolutionSource: { type: "state", key: "TX", marketId: "market-state" },
              baselinePrice: 100,
              componentAdjustments: [{ component: "labor", adjustmentPercent: 8 }],
            },
          },
        },
        {
          id: "rec-rerun",
          extractionMatchId: "match-1",
          status: "pending_review",
          createdByRunId: "run-rerun",
          sourceType: "explicit",
          normalizedIntent: "roofing tearoff",
          sourceRowIdentity: "roof:tearoff-1",
          sectionName: "Roof",
        },
      ],
      generationRuns: [
        {
          id: "run-rerun",
          status: "running",
          inputSnapshotJson: { rerunRequestId: "rerun-1" },
          startedAt: new Date("2026-04-21T12:00:00Z"),
          completedAt: null,
          errorSummary: null,
        },
        {
          id: "run-completed",
          status: "completed",
          inputSnapshotJson: {},
          startedAt: new Date("2026-04-21T11:00:00Z"),
          completedAt: new Date("2026-04-21T11:05:00Z"),
          errorSummary: null,
        },
      ],
      jobs: [
        {
          id: 71,
          jobType: "estimate_generation",
          status: "pending",
          payload: { dealId: "deal-1", rerunRequestId: "rerun-1" },
          createdAt: new Date("2026-04-21T11:55:00Z"),
        },
      ],
    });

    const state = await buildEstimatingWorkbenchState(tenantDb, "deal-1", {
      appDb,
      officeId: "office-1",
    });

    expect(state.activePricingRunId).toBe("run-completed");
    expect(state.pricingRows).toHaveLength(1);
    expect(state.pricingRows[0]).toMatchObject({
      id: "rec-completed",
      marketRateRationale: expect.objectContaining({
        resolutionLevel: "state",
      }),
      marketRateContext: expect.objectContaining({
        resolutionLevel: "state",
      }),
    });
    expect(state.marketContext).toMatchObject({
      effectiveMarket: expect.objectContaining({ id: "market-state" }),
      resolutionLevel: "state",
      isOverridden: false,
      fallbackSource: {
        type: "state",
        key: "TX",
        marketId: "market-state",
      },
    });
    expect(state.rerunStatus).toEqual({
      status: "running",
      rerunRequestId: "rerun-1",
      queueJobId: 71,
      generationRunId: "run-rerun",
      source: "generation_run",
      errorSummary: null,
    });
    expect(state.manualAddContext.generationRunId).toBe("run-completed");
  });

  it("surfaces override metadata distinctly from auto-detected markets and keeps fallback rows separate", async () => {
    dealMarketOverrideServiceMocks.getDealEffectiveMarketContext.mockResolvedValueOnce({
      dealId: "deal-1",
      effectiveMarketContext: {
        market: {
          id: "market-override",
          name: "Dallas Override",
          slug: "dfw-override",
          type: "metro",
        },
        resolutionLevel: "override",
        resolutionSource: {
          type: "override",
          key: "deal-1",
          marketId: "market-override",
        },
        location: {
          zip: "75001",
          state: "TX",
          regionId: "region-south",
        },
      },
      currentOverride: {
        marketId: "market-override",
        overriddenByUserId: "user-1",
        overrideReason: "Estimator override",
        updatedAt: new Date("2026-04-21T12:00:00Z"),
      },
    });

    const { tenantDb } = makeDb({
      documents: [{ id: "doc-1", activeParseRunId: "parse-1", ocrStatus: "completed" }],
      extractions: [
        {
          id: "ext-1",
          documentId: "doc-1",
          status: "approved",
          metadataJson: { sourceParseRunId: "parse-1", activeArtifact: true },
        },
      ],
      matches: [{ id: "match-1", extractionId: "ext-1", status: "selected" }],
      pricing: [
        {
          id: "rec-1",
          extractionMatchId: "match-1",
          status: "approved",
          createdByRunId: "run-1",
          sourceType: "explicit",
          normalizedIntent: "coping metal",
          sourceRowIdentity: "roof:coping-1",
          sectionName: "Roof",
        },
      ],
      generationRuns: [
        {
          id: "run-1",
          status: "completed",
          inputSnapshotJson: {},
          startedAt: new Date("2026-04-21T11:00:00Z"),
          completedAt: new Date("2026-04-21T11:05:00Z"),
          errorSummary: null,
        },
      ],
    });

    const state = await buildEstimatingWorkbenchState(tenantDb, "deal-1");

    expect(state.marketContext).toMatchObject({
      resolutionLevel: "override",
      isOverridden: true,
      override: {
        marketId: "market-override",
        overrideReason: "Estimator override",
      },
    });
    expect(state.marketContext?.fallbackSource).toBeNull();
  });

  it("keeps promotion duplicate-blocking behavior intact", async () => {
    const { tenantDb } = makeDb({
      documents: [{ id: "doc-1", activeParseRunId: "run-1", ocrStatus: "completed" }],
      extractions: [
        {
          id: "ext-1",
          documentId: "doc-1",
          status: "approved",
          metadataJson: { sourceParseRunId: "run-1", activeArtifact: true },
        },
      ],
      matches: [{ id: "match-1", extractionId: "ext-1", status: "selected" }],
      pricing: [
        {
          id: "rec-approved",
          extractionMatchId: "match-1",
          status: "approved",
          createdByRunId: "run-1",
          sourceType: "explicit",
          normalizedIntent: "coping metal",
          sourceRowIdentity: "roof:coping-1",
          sectionName: "Roof",
        },
        {
          id: "rec-pending",
          extractionMatchId: "match-1",
          status: "pending_review",
          createdByRunId: "run-1",
          sourceType: "explicit",
          normalizedIntent: "coping metal",
          sourceRowIdentity: "roof:coping-2",
          sectionName: "Roof",
        },
        {
          id: "rec-rejected",
          extractionMatchId: "match-1",
          status: "rejected",
          createdByRunId: "run-1",
          sourceType: "explicit",
          normalizedIntent: "coping metal",
          sourceRowIdentity: "roof:coping-3",
          sectionName: "Roof",
        },
      ],
    });

    const state = await buildEstimatingWorkbenchState(tenantDb, "deal-1");

    expect(state.summary.pricing).toEqual({
      total: 3,
      pending: 1,
      approved: 1,
      overridden: 0,
      rejected: 1,
      readyToPromote: 1,
    });
    expect(state.pricingRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "rec-approved",
          duplicateGroupBlocked: false,
          promotable: true,
          reviewState: "approved",
        }),
      ])
    );
  });
});

describe("updateEstimatePricingRecommendationReviewState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects switch_to_alternate when the selected option is not an alternate", async () => {
    const updateReturning = vi.fn().mockResolvedValue([
      {
        id: "rec-1",
        status: "approved",
        selectedSourceType: "alternate",
        selectedOptionId: "option-1",
        recommendedUnitPrice: "10.00",
        recommendedTotalPrice: "10.00",
        overrideQuantity: null,
        overrideUnit: null,
        overrideUnitPrice: null,
        overrideNotes: null,
      },
    ]);
    const insertReturning = vi.fn().mockResolvedValue([
      {
        id: "evt-1",
        eventType: "switched_to_alternate",
      },
    ]);
    const tenantDb = {
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([
                {
                  id: "rec-1",
                  dealId: "deal-1",
                  status: "pending_review",
                  selectedSourceType: null,
                  selectedOptionId: null,
                  recommendedUnitPrice: "10.00",
                  recommendedTotalPrice: "10.00",
                  overrideQuantity: null,
                  overrideUnit: null,
                  overrideUnitPrice: null,
                  overrideNotes: null,
                },
              ]),
            })),
          })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            innerJoin: vi.fn(() => ({
              where: vi.fn(() => ({
                limit: vi.fn().mockResolvedValue([
                  {
                    id: "option-1",
                    recommendationId: "rec-1",
                    optionLabel: "Base option",
                    optionKind: "recommended",
                  },
                ]),
              })),
            })),
          })),
        }),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: updateReturning,
          })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: insertReturning,
        })),
      })),
    } as any;

    await expect(
      updateEstimatePricingRecommendationReviewState({
        tenantDb,
        dealId: "deal-1",
        recommendationId: "rec-1",
        userId: "user-1",
        input: {
          action: "switch_to_alternate",
          alternateOptionId: "option-1",
        },
      })
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(updateReturning).not.toHaveBeenCalled();
    expect(insertReturning).not.toHaveBeenCalled();
  });

  it("rejects overrides that omit pricing values", async () => {
    const tenantDb = {
      select: vi.fn().mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([
              {
                id: "rec-override-missing",
                dealId: "deal-1",
                status: "pending_review",
                selectedSourceType: null,
                selectedOptionId: null,
                recommendedUnitPrice: null,
                recommendedTotalPrice: null,
                overrideQuantity: null,
                overrideUnit: null,
                overrideUnitPrice: null,
                overrideNotes: null,
              },
            ]),
          })),
        })),
      }),
    } as any;

    await expect(
      updateEstimatePricingRecommendationReviewState({
        tenantDb,
        dealId: "deal-1",
        recommendationId: "rec-override-missing",
        userId: "user-1",
        input: {
          action: "override",
          recommendedUnitPrice: "",
          recommendedTotalPrice: "",
          reason: "Need manual pricing",
        },
      })
    ).rejects.toThrow("Override price and total are required");
  });

  it("rejects overrides that provide malformed numeric values", async () => {
    const tenantDb = {
      select: vi.fn().mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([
              {
                id: "rec-override-invalid",
                dealId: "deal-1",
                status: "pending_review",
                selectedSourceType: null,
                selectedOptionId: null,
                recommendedUnitPrice: "10.00",
                recommendedTotalPrice: "20.00",
                overrideQuantity: null,
                overrideUnit: null,
                overrideUnitPrice: null,
                overrideNotes: null,
              },
            ]),
          })),
        })),
      }),
    } as any;

    await expect(
      updateEstimatePricingRecommendationReviewState({
        tenantDb,
        dealId: "deal-1",
        recommendationId: "rec-override-invalid",
        userId: "user-1",
        input: {
          action: "override",
          recommendedUnitPrice: "12x",
          recommendedTotalPrice: "24.00",
          reason: "Need manual pricing",
        },
      })
    ).rejects.toThrow("Override unit price must be a valid number");
  });

  it("records catalog option provenance when accepting the recommended option", async () => {
    const updateReturning = vi.fn().mockResolvedValue([
      {
        id: "rec-1",
        status: "approved",
        selectedSourceType: "catalog_option",
        selectedOptionId: "option-rec",
        recommendedUnitPrice: "10.00",
        recommendedTotalPrice: "10.00",
        overrideQuantity: null,
        overrideUnit: null,
        overrideUnitPrice: null,
        overrideNotes: null,
      },
    ]);
    const insertReturning = vi.fn().mockResolvedValue([
      {
        id: "evt-2",
        eventType: "accepted_recommended",
      },
    ]);
    const tenantDb = {
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([
                {
                  id: "rec-1",
                  dealId: "deal-1",
                  status: "pending_review",
                  promotedEstimateLineItemId: null,
                  selectedSourceType: null,
                  selectedOptionId: null,
                  recommendedUnitPrice: "10.00",
                  recommendedTotalPrice: "10.00",
                  overrideQuantity: null,
                  overrideUnit: null,
                  overrideUnitPrice: null,
                  overrideNotes: null,
                },
              ]),
            })),
          })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            innerJoin: vi.fn(() => ({
              where: vi.fn(() => ({
                limit: vi.fn().mockResolvedValue([
                  {
                    id: "option-rec",
                    recommendationId: "rec-1",
                    optionLabel: "Catalog option",
                    optionKind: "recommended",
                  },
                ]),
              })),
            })),
          })),
        }),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: updateReturning,
          })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: insertReturning,
        })),
      })),
    } as any;

    const result = await updateEstimatePricingRecommendationReviewState({
      tenantDb,
      dealId: "deal-1",
      recommendationId: "rec-1",
      userId: "user-1",
      input: {
        action: "accept_recommended",
      },
    });

    expect(result.recommendation.selectedSourceType).toBe("catalog_option");
    expect(result.recommendation.selectedOptionId).toBe("option-rec");
    expect(result.reviewEvent.eventType).toBe("accepted_recommended");
  });

  it("blocks review-state mutations after a recommendation is promoted", async () => {
    const updateReturning = vi.fn();
    const insertReturning = vi.fn();
    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([
              {
                id: "rec-1",
                dealId: "deal-1",
                status: "approved",
                promotedEstimateLineItemId: "line-1",
                selectedSourceType: "catalog_option",
                selectedOptionId: "option-rec",
                recommendedUnitPrice: "10.00",
                recommendedTotalPrice: "10.00",
                overrideQuantity: null,
                overrideUnit: null,
                overrideUnitPrice: null,
                overrideNotes: null,
              },
            ]),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: updateReturning,
          })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: insertReturning,
        })),
      })),
    } as any;

    await expect(
      updateEstimatePricingRecommendationReviewState({
        tenantDb,
        dealId: "deal-1",
        recommendationId: "rec-1",
        userId: "user-1",
        input: {
          action: "reject",
          reason: "too late",
        },
      })
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(updateReturning).not.toHaveBeenCalled();
    expect(insertReturning).not.toHaveBeenCalled();
  });
});
