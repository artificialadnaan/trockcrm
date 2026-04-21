import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildEstimatingWorkbenchState,
  updateEstimatePricingRecommendationReviewState,
} from "../../../src/modules/estimating/workbench-service.js";

function makeQueryResult(resolved: any) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        orderBy: vi.fn().mockResolvedValue(resolved),
      })),
    })),
  };
}

function makeJoinQueryResult(resolved: any) {
  return {
    from: vi.fn(() => ({
      innerJoin: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn().mockResolvedValue(resolved),
        })),
      })),
    })),
  };
}

function makeTenantDb(results: any[]) {
  return {
    select: vi.fn()
      .mockReturnValueOnce(makeQueryResult(results[0]))
      .mockReturnValueOnce(makeQueryResult(results[1]))
      .mockReturnValueOnce(makeJoinQueryResult(results[2]))
      .mockReturnValueOnce(makeQueryResult(results[3]))
      .mockReturnValueOnce(makeQueryResult(results[4])),
  } as any;
}

describe("buildEstimatingWorkbenchState", () => {
  it("filters workbench rows to the active parse run before summarizing", async () => {
    const tenantDb = makeTenantDb([
      [
        { id: "doc-1", activeParseRunId: "run-1", ocrStatus: "queued" },
        { id: "doc-2", activeParseRunId: "run-2", ocrStatus: "failed" },
      ],
      [
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
      [
        { id: "match-1", extractionId: "ext-1", status: "suggested" },
        { id: "match-2", extractionId: "ext-3", status: "selected" },
        { id: "match-3", extractionId: "ext-4", status: "rejected" },
      ],
      [
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
      [{ id: "event-1" }],
    ]);

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
  });

  it("keeps promotion disabled when eligible rows have no generation run ids", async () => {
    const tenantDb = makeTenantDb([
      [{ id: "doc-1", activeParseRunId: "run-1", ocrStatus: "completed" }],
      [
        {
          id: "ext-1",
          documentId: "doc-1",
          status: "approved",
          metadataJson: { sourceParseRunId: "run-1", activeArtifact: true },
        },
      ],
      [{ id: "match-1", extractionId: "ext-1", status: "selected" }],
      [
        {
          id: "rec-1",
          extractionMatchId: "match-1",
          status: "approved",
          createdByRunId: null,
        },
        {
          id: "rec-2",
          extractionMatchId: "match-1",
          status: "overridden",
          createdByRunId: "",
        },
      ],
      [],
    ]);

    const state = await buildEstimatingWorkbenchState(tenantDb, "deal-1");

    expect(state.summary).toEqual({
      documents: {
        total: 1,
        queued: 0,
        failed: 0,
      },
      extractions: {
        total: 1,
        pending: 0,
        approved: 1,
        rejected: 0,
        unmatched: 0,
      },
      matches: {
        total: 1,
        suggested: 0,
        selected: 1,
        rejected: 0,
      },
      pricing: {
        total: 2,
        pending: 0,
        approved: 1,
        overridden: 1,
        rejected: 0,
        readyToPromote: 2,
      },
    });
    expect(state.promotionReadiness).toEqual({
      canPromote: false,
      generationRunIds: [],
    });
  });

  it("groups explicit duplicates by section, auto-suppresses inferred rows, and blocks promotion", async () => {
    const tenantDb = makeTenantDb([
      [{ id: "doc-1", activeParseRunId: "run-1", ocrStatus: "completed" }],
      [
        {
          id: "ext-1",
          documentId: "doc-1",
          status: "approved",
          metadataJson: { sourceParseRunId: "run-1", activeArtifact: true },
        },
      ],
      [{ id: "match-1", extractionId: "ext-1", status: "selected" }],
      [
        {
          id: "rec-1",
          extractionMatchId: "match-1",
          status: "approved",
          createdByRunId: "run-1",
          sourceType: "explicit",
          normalizedIntent: "parapet flashing",
          sourceRowIdentity: "roof:parapet-1",
          sectionName: "Roof",
        },
        {
          id: "rec-2",
          extractionMatchId: "match-1",
          status: "approved",
          createdByRunId: "run-1",
          sourceType: "explicit",
          normalizedIntent: "parapet flashing",
          sourceRowIdentity: "roof:parapet-2",
          sectionName: "Roof",
        },
        {
          id: "rec-3",
          extractionMatchId: "match-1",
          status: "approved",
          createdByRunId: "run-1",
          sourceType: "inferred",
          normalizedIntent: "parapet flashing",
          sourceRowIdentity: "roof:parapet-3",
          sectionName: "Roof",
        },
      ],
      [],
    ]);

    const state = await buildEstimatingWorkbenchState(tenantDb, "deal-1");

    expect(state.summary.pricing).toEqual({
      total: 3,
      pending: 0,
      approved: 3,
      overridden: 0,
      rejected: 0,
      readyToPromote: 0,
    });
    expect(state.promotionReadiness).toEqual({
      canPromote: false,
      generationRunIds: [],
    });
    expect(state.pricingRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "rec-1",
          duplicateGroupKey: "Roof::parapet flashing",
          duplicateGroupBlocked: true,
          suppressedByDuplicateGroup: false,
          promotable: false,
          reviewState: "approved",
        }),
        expect.objectContaining({
          id: "rec-2",
          duplicateGroupKey: "Roof::parapet flashing",
          duplicateGroupBlocked: true,
          suppressedByDuplicateGroup: false,
          promotable: false,
          reviewState: "approved",
        }),
        expect.objectContaining({
          id: "rec-3",
          duplicateGroupKey: "Roof::parapet flashing",
          duplicateGroupBlocked: true,
          suppressedByDuplicateGroup: true,
          promotable: false,
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
});
