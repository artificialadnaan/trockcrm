import { beforeEach, describe, expect, it, vi } from "vitest";

const estimateServiceMocks = vi.hoisted(() => ({
  createSection: vi.fn(),
  createLineItem: vi.fn(),
}));

vi.mock("../../../src/modules/deals/estimate-service.js", () => ({
  createSection: estimateServiceMocks.createSection,
  createLineItem: estimateServiceMocks.createLineItem,
}));

const {
  approveEstimateRecommendation,
  promoteApprovedRecommendationsToEstimate,
} = await import("../../../src/modules/estimating/draft-estimate-service.js");

describe("promoteApprovedRecommendationsToEstimate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates canonical estimate sections and line items from approved recommendations", async () => {
    estimateServiceMocks.createSection.mockResolvedValue({ id: "section-1" });
    estimateServiceMocks.createLineItem.mockResolvedValue({ id: "line-1" });

    const updateReturning = vi.fn().mockResolvedValue([{ id: "rec-1", promotedEstimateLineItemId: "line-1" }]);

    const tenantDb = {
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn().mockResolvedValue([]),
          })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            innerJoin: vi.fn(() => ({
              innerJoin: vi.fn(() => ({
                where: vi.fn().mockResolvedValue([
                  {
                    recommendationId: "rec-1",
                    description: "Parapet Wall Flashing",
                    quantity: "3",
                    unit: "ft",
                    unitPrice: "121.54",
                    notes: null,
                    sectionName: "Generated Estimate",
                  },
                ]),
              })),
            })),
          })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([]),
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
        values: vi.fn().mockResolvedValue(undefined),
      })),
    } as any;

    await promoteApprovedRecommendationsToEstimate({
      tenantDb,
      dealId: "deal-1",
      generationRunId: "run-1",
      approvedRecommendationIds: ["rec-1"],
    });

    expect(estimateServiceMocks.createSection).toHaveBeenCalled();
    expect(estimateServiceMocks.createLineItem).toHaveBeenCalled();
    expect(updateReturning).toHaveBeenCalled();
  });

  it("is idempotent for the same approved recommendation set", async () => {
    const tenantDb = {
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn().mockResolvedValue([{ subjectId: "rec-1" }]),
          })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            innerJoin: vi.fn(() => ({
              innerJoin: vi.fn(() => ({
                where: vi.fn().mockResolvedValue([]),
              })),
            })),
          })),
        }),
      insert: vi.fn(() => ({
        values: vi.fn().mockResolvedValue(undefined),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([{ id: "rec-2", promotedEstimateLineItemId: "line-1" }]),
          })),
        })),
      })),
    } as any;

    await promoteApprovedRecommendationsToEstimate({
      tenantDb,
      dealId: "deal-1",
      generationRunId: "run-1",
      approvedRecommendationIds: ["rec-1"],
    });

    expect(estimateServiceMocks.createSection).not.toHaveBeenCalled();
    expect(estimateServiceMocks.createLineItem).not.toHaveBeenCalled();
  });

  it("reuses an existing section when later promotions land in the same section", async () => {
    estimateServiceMocks.createLineItem.mockResolvedValue({ id: "line-1" });

    const tenantDb = {
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn().mockResolvedValue([]),
          })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            innerJoin: vi.fn(() => ({
              innerJoin: vi.fn(() => ({
                where: vi.fn().mockResolvedValue([
                  {
                    recommendationId: "rec-2",
                    description: "Mobilization",
                    quantity: "1",
                    unit: "ea",
                    unitPrice: "500",
                    notes: null,
                    sectionName: "Generated Estimate",
                  },
                ]),
              })),
            })),
          })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([{ id: "section-existing" }]),
            })),
          })),
        }),
      insert: vi.fn(() => ({
        values: vi.fn().mockResolvedValue(undefined),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([{ id: "rec-2", promotedEstimateLineItemId: "line-1" }]),
          })),
        })),
      })),
    } as any;

    await promoteApprovedRecommendationsToEstimate({
      tenantDb,
      dealId: "deal-1",
      generationRunId: "run-2",
      approvedRecommendationIds: ["rec-2"],
    });

    expect(estimateServiceMocks.createSection).not.toHaveBeenCalled();
    expect(estimateServiceMocks.createLineItem).toHaveBeenCalledWith(
      tenantDb,
      "deal-1",
      "section-existing",
      expect.objectContaining({ description: "Mobilization" })
    );
  });

  it("promotes overridden recommendations that satisfy the gating rules", async () => {
    estimateServiceMocks.createSection.mockResolvedValue({ id: "section-ovr" });
    estimateServiceMocks.createLineItem.mockResolvedValue({ id: "line-ovr" });
    const updateReturning = vi.fn().mockResolvedValue([{ id: "rec-ovr", promotedEstimateLineItemId: "line-ovr" }]);

    const tenantDb = {
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn().mockResolvedValue([]),
          })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            innerJoin: vi.fn(() => ({
              innerJoin: vi.fn(() => ({
                where: vi.fn().mockResolvedValue([
                  {
                    recommendationId: "rec-ovr",
                    description: "Seam Sealant",
                    quantity: "2",
                    unit: "ea",
                    unitPrice: "75.00",
                    notes: null,
                    sectionName: "Roof",
                    sourceType: "explicit",
                    normalizedIntent: "seam sealant",
                    sourceRowIdentity: "roof:seam-1",
                    status: "overridden",
                    createdByRunId: "run-3",
                    promotedEstimateLineItemId: null,
                  },
                ]),
              })),
            })),
          })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([]),
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
        values: vi.fn().mockResolvedValue(undefined),
      })),
    } as any;

    const result = await promoteApprovedRecommendationsToEstimate({
      tenantDb,
      dealId: "deal-1",
      generationRunId: "run-3",
      approvedRecommendationIds: ["rec-ovr"],
    });

    expect(result.promotedRecommendationIds).toEqual(["rec-ovr"]);
    expect(result.rowErrors).toEqual([]);
    expect(estimateServiceMocks.createSection).toHaveBeenCalled();
    expect(estimateServiceMocks.createLineItem).toHaveBeenCalled();
    expect(updateReturning).toHaveBeenCalled();
  });

  it("rejects approval when the recommendation does not exist", async () => {
    const insertValues = vi.fn();
    const tenantDb = {
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([]),
          })),
        })),
      })),
      insert: vi.fn(() => ({
        values: insertValues,
      })),
    } as any;

    await expect(
      approveEstimateRecommendation({
        tenantDb,
        dealId: "deal-1",
        recommendationId: "missing-rec",
        userId: "user-1",
      })
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("blocks duplicate recommendations from promotion and returns row-level errors", async () => {
    const tenantDb = {
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn().mockResolvedValue([]),
          })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            innerJoin: vi.fn(() => ({
              innerJoin: vi.fn(() => ({
                where: vi.fn().mockResolvedValue([
                  {
                    recommendationId: "rec-dup-1",
                    description: "Parapet Wall Flashing",
                    quantity: "3",
                    unit: "ft",
                    unitPrice: "121.54",
                    notes: null,
                    sectionName: "Roof",
                    sourceType: "explicit",
                    normalizedIntent: "parapet flashing",
                    sourceRowIdentity: "roof:parapet-1",
                    promotedEstimateLineItemId: null,
                  },
                  {
                    recommendationId: "rec-dup-2",
                    description: "Parapet Wall Flashing",
                    quantity: "3",
                    unit: "ft",
                    unitPrice: "121.54",
                    notes: null,
                    sectionName: "Roof",
                    sourceType: "explicit",
                    normalizedIntent: "parapet flashing",
                    sourceRowIdentity: "roof:parapet-2",
                    promotedEstimateLineItemId: null,
                  },
                ]),
              })),
            })),
          })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([]),
            })),
          })),
        }),
      insert: vi.fn(() => ({
        values: vi.fn().mockResolvedValue(undefined),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([]),
          })),
        })),
      })),
    } as any;

    const result = await promoteApprovedRecommendationsToEstimate({
      tenantDb,
      dealId: "deal-1",
      generationRunId: "run-1",
      approvedRecommendationIds: ["rec-dup-1", "rec-dup-2"],
    });

    expect(estimateServiceMocks.createSection).not.toHaveBeenCalled();
    expect(estimateServiceMocks.createLineItem).not.toHaveBeenCalled();
    expect(result.rowErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recommendationId: "rec-dup-1",
          code: "duplicate_blocked",
        }),
        expect.objectContaining({
          recommendationId: "rec-dup-2",
          code: "duplicate_blocked",
        }),
      ])
    );
  });
});
