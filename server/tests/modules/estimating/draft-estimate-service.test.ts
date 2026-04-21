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
  cloneManualRowsForGenerationRun,
  listApprovedRecommendationIdsForRun,
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
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi
        .fn()
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
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi
        .fn()
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
                    status: "approved",
                    createdByRunId: "run-1",
                    promotedEstimateLineItemId: "line-1",
                  },
                ]),
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
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi
        .fn()
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
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi
        .fn()
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

  it("uses the selected alternate option label when promoting alternate-selected rows", async () => {
    estimateServiceMocks.createSection.mockResolvedValue({ id: "section-alt" });
    estimateServiceMocks.createLineItem.mockResolvedValue({ id: "line-alt" });
    const updateReturning = vi.fn().mockResolvedValue([{ id: "rec-alt", promotedEstimateLineItemId: "line-alt" }]);

    const tenantDb = {
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            innerJoin: vi.fn(() => ({
              innerJoin: vi.fn(() => ({
                where: vi.fn().mockResolvedValue([
                  {
                    recommendationId: "rec-alt",
                    description: "Recommendation default label",
                    quantity: "4",
                    unit: "ea",
                    unitPrice: "32.00",
                    notes: "Default notes",
                    sectionName: "Roof",
                    sourceType: "explicit",
                    selectedSourceType: "alternate",
                    selectedOptionId: "option-2",
                    normalizedIntent: "roof vent",
                    sourceRowIdentity: "roof:vent-1",
                    status: "approved",
                    createdByRunId: "run-alt",
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
              limit: vi.fn().mockResolvedValue([{ id: "section-alt" }]),
            })),
          })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            innerJoin: vi.fn(() => ({
              where: vi.fn(() => ({
                limit: vi.fn().mockResolvedValue([
                  {
                    id: "option-2",
                    optionLabel: "Alternate vent cover",
                    optionKind: "alternate",
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
      generationRunId: "run-alt",
      approvedRecommendationIds: ["rec-alt"],
    });

    expect(estimateServiceMocks.createLineItem).toHaveBeenCalledWith(
      tenantDb,
      "deal-1",
      "section-alt",
      expect.objectContaining({
        description: "Alternate vent cover",
      })
    );
    expect(updateReturning).toHaveBeenCalled();
  });

  it("uses manual baseline values when promoting accepted manual rows", async () => {
    estimateServiceMocks.createSection.mockResolvedValue({ id: "section-manual" });
    estimateServiceMocks.createLineItem.mockResolvedValue({ id: "line-manual" });
    const updateReturning = vi.fn().mockResolvedValue([{ id: "rec-manual", promotedEstimateLineItemId: "line-manual" }]);

    const tenantDb = {
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            innerJoin: vi.fn(() => ({
              innerJoin: vi.fn(() => ({
                where: vi.fn().mockResolvedValue([
                  {
                    recommendationId: "rec-manual",
                    description: "Stale extracted label",
                    quantity: "9",
                    unit: "sq",
                    unitPrice: "11.00",
                    notes: "stale note",
                    sectionName: "Roof",
                    sourceType: "explicit",
                    selectedSourceType: "manual",
                    selectedOptionId: null,
                    manualLabel: "Manual baseline label",
                    manualQuantity: "2",
                    manualUnit: "ea",
                    manualUnitPrice: "75.00",
                    manualNotes: "manual note",
                    normalizedIntent: "manual row",
                    sourceRowIdentity: "roof:manual-1",
                    status: "approved",
                    createdByRunId: "run-manual",
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

    await promoteApprovedRecommendationsToEstimate({
      tenantDb,
      dealId: "deal-1",
      generationRunId: "run-manual",
      approvedRecommendationIds: ["rec-manual"],
    });

    expect(estimateServiceMocks.createLineItem).toHaveBeenCalledWith(
      tenantDb,
      "deal-1",
      "section-manual",
      expect.objectContaining({
        description: "Manual baseline label",
        quantity: "2",
        unit: "ea",
        unitPrice: "75.00",
        notes: "manual note",
      })
    );
  });

  it("falls back to legacy manual fields when promoting catalog-backed manual rows", async () => {
    estimateServiceMocks.createSection.mockResolvedValue({ id: "section-manual-catalog" });
    estimateServiceMocks.createLineItem.mockResolvedValue({ id: "line-manual-catalog" });
    const updateReturning = vi.fn().mockResolvedValue([
      { id: "rec-manual-catalog", promotedEstimateLineItemId: "line-manual-catalog" },
    ]);

    const tenantDb = {
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            innerJoin: vi.fn(() => ({
              innerJoin: vi.fn(() => ({
                where: vi.fn().mockResolvedValue([
                  {
                    recommendationId: "rec-manual-catalog",
                    description: "Stale extracted label",
                    quantity: null,
                    unit: null,
                    unitPrice: null,
                    notes: null,
                    sectionName: "Roof",
                    sourceType: "manual",
                    selectedSourceType: "catalog_option",
                    selectedOptionId: "option-catalog-1",
                    manualLabel: "Legacy manual label",
                    manualQuantity: "3",
                    manualUnit: "ea",
                    manualUnitPrice: "42.00",
                    manualNotes: "legacy manual note",
                    normalizedIntent: "manual row",
                    sourceRowIdentity: "roof:manual-catalog-legacy",
                    status: "approved",
                    createdByRunId: "run-manual-catalog",
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
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            innerJoin: vi.fn(() => ({
              where: vi.fn(() => ({
                limit: vi.fn().mockResolvedValue([
                  {
                    id: "option-catalog-1",
                    optionLabel: "Catalog-backed manual option",
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
        values: vi.fn().mockResolvedValue(undefined),
      })),
    } as any;

    await promoteApprovedRecommendationsToEstimate({
      tenantDb,
      dealId: "deal-1",
      generationRunId: "run-manual-catalog",
      approvedRecommendationIds: ["rec-manual-catalog"],
    });

    expect(estimateServiceMocks.createLineItem).toHaveBeenCalledWith(
      tenantDb,
      "deal-1",
      "section-manual-catalog",
      expect.objectContaining({
        description: "Catalog-backed manual option",
        quantity: "3",
        unit: "ea",
        unitPrice: "42.00",
        notes: "legacy manual note",
      })
    );
  });

  it("falls back to legacy manual fields when a manual row has no selectedSourceType", async () => {
    estimateServiceMocks.createSection.mockResolvedValue({ id: "section-legacy-manual" });
    estimateServiceMocks.createLineItem.mockResolvedValue({ id: "line-legacy-manual" });
    const updateReturning = vi.fn().mockResolvedValue([
      { id: "rec-legacy-manual", promotedEstimateLineItemId: "line-legacy-manual" },
    ]);

    const tenantDb = {
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            innerJoin: vi.fn(() => ({
              innerJoin: vi.fn(() => ({
                where: vi.fn().mockResolvedValue([
                  {
                    recommendationId: "rec-legacy-manual",
                    description: "Legacy manual description",
                    quantity: null,
                    unit: null,
                    unitPrice: null,
                    notes: null,
                    sectionName: "Roof",
                    sourceType: "manual",
                    selectedSourceType: null,
                    selectedOptionId: null,
                    manualLabel: "Legacy manual label",
                    manualQuantity: "5",
                    manualUnit: "ea",
                    manualUnitPrice: "12.00",
                    manualNotes: "legacy note",
                    normalizedIntent: "manual row",
                    sourceRowIdentity: "roof:legacy-manual",
                    status: "approved",
                    createdByRunId: "run-legacy-manual",
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

    await promoteApprovedRecommendationsToEstimate({
      tenantDb,
      dealId: "deal-1",
      generationRunId: "run-legacy-manual",
      approvedRecommendationIds: ["rec-legacy-manual"],
    });

    expect(estimateServiceMocks.createLineItem).toHaveBeenCalledWith(
      tenantDb,
      "deal-1",
      "section-legacy-manual",
      expect.objectContaining({
        description: "Legacy manual label",
        quantity: "5",
        unit: "ea",
        unitPrice: "12.00",
        notes: "legacy note",
      })
    );
  });

  it("blocks promotion for manual rows that still lack pricing", async () => {
    const tenantDb = {
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            innerJoin: vi.fn(() => ({
              innerJoin: vi.fn(() => ({
                where: vi.fn().mockResolvedValue([
                  {
                    recommendationId: "rec-manual-incomplete",
                    description: "Stale extracted label",
                    quantity: null,
                    unit: "sq",
                    unitPrice: null,
                    notes: "stale note",
                    sectionName: "Roof",
                    sourceType: "manual",
                    selectedSourceType: "manual",
                    selectedOptionId: null,
                    manualLabel: "Manual baseline label",
                    manualQuantity: null,
                    manualUnit: "ea",
                    manualUnitPrice: null,
                    manualNotes: "manual note",
                    normalizedIntent: "manual row",
                    sourceRowIdentity: "roof:manual-incomplete",
                    status: "approved",
                    createdByRunId: "run-manual",
                    promotedEstimateLineItemId: null,
                  },
                ]),
              })),
            })),
          })),
        }),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([]),
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
      generationRunId: "run-manual",
      approvedRecommendationIds: ["rec-manual-incomplete"],
    });

    expect(estimateServiceMocks.createLineItem).not.toHaveBeenCalled();
    expect(result.promotedRecommendationIds).toEqual([]);
    expect(result.rowErrors).toEqual([
      expect.objectContaining({
        recommendationId: "rec-manual-incomplete",
        code: "not_promotable",
      }),
    ]);
  });

  it("uses override values when promoting overridden rows", async () => {
    estimateServiceMocks.createSection.mockResolvedValue({ id: "section-override" });
    estimateServiceMocks.createLineItem.mockResolvedValue({ id: "line-override" });
    const updateReturning = vi.fn().mockResolvedValue([{ id: "rec-override", promotedEstimateLineItemId: "line-override" }]);

    const tenantDb = {
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            innerJoin: vi.fn(() => ({
              innerJoin: vi.fn(() => ({
                where: vi.fn().mockResolvedValue([
                  {
                    recommendationId: "rec-override",
                    description: "Existing description",
                    quantity: "9",
                    unit: "sq",
                    unitPrice: "11.00",
                    notes: "stale note",
                    sectionName: "Roof",
                    sourceType: "explicit",
                    selectedSourceType: "override",
                    selectedOptionId: null,
                    overrideQuantity: "4",
                    overrideUnit: "ea",
                    overrideUnitPrice: "125.00",
                    overrideNotes: "override note",
                    normalizedIntent: "override row",
                    sourceRowIdentity: "roof:override-1",
                    status: "overridden",
                    createdByRunId: "run-override",
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

    await promoteApprovedRecommendationsToEstimate({
      tenantDb,
      dealId: "deal-1",
      generationRunId: "run-override",
      approvedRecommendationIds: ["rec-override"],
    });

    expect(estimateServiceMocks.createLineItem).toHaveBeenCalledWith(
      tenantDb,
      "deal-1",
      "section-override",
      expect.objectContaining({
        description: "Existing description",
        quantity: "4",
        unit: "ea",
        unitPrice: "125.00",
        notes: "override note",
      })
    );
  });

  it("claims promotion with a lock before creating canonical line items", async () => {
    estimateServiceMocks.createSection.mockResolvedValue({ id: "section-lock" });
    estimateServiceMocks.createLineItem.mockResolvedValue({ id: "line-lock" });
    const updateReturning = vi.fn().mockResolvedValue([{ id: "rec-lock", promotedEstimateLineItemId: "line-lock" }]);
    const execute = vi.fn().mockResolvedValue(undefined);

    const tenantDb = {
      execute,
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            innerJoin: vi.fn(() => ({
              innerJoin: vi.fn(() => ({
                where: vi.fn().mockResolvedValue([
                  {
                    recommendationId: "rec-lock",
                    description: "Termination Bar",
                    quantity: "1",
                    unit: "ea",
                    unitPrice: "25.00",
                    notes: null,
                    sectionName: "Roof",
                    sourceType: "explicit",
                    normalizedIntent: "termination bar",
                    sourceRowIdentity: "roof:termination-bar",
                    status: "approved",
                    createdByRunId: "run-lock",
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

    await promoteApprovedRecommendationsToEstimate({
      tenantDb,
      dealId: "deal-1",
      generationRunId: "run-lock",
      approvedRecommendationIds: ["rec-lock"],
    });

    expect(execute).toHaveBeenCalled();
    expect(
      execute.mock.invocationCallOrder[0]
    ).toBeLessThan(estimateServiceMocks.createLineItem.mock.invocationCallOrder[0]);
  });

  it("runs promotion writes inside a transaction when available", async () => {
    estimateServiceMocks.createSection.mockResolvedValue({ id: "section-tx" });
    estimateServiceMocks.createLineItem.mockResolvedValue({ id: "line-tx" });
    const updateReturning = vi.fn().mockResolvedValue([{ id: "rec-tx", promotedEstimateLineItemId: "line-tx" }]);

    const txDb = {
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            innerJoin: vi.fn(() => ({
              innerJoin: vi.fn(() => ({
                where: vi.fn().mockResolvedValue([
                  {
                    recommendationId: "rec-tx",
                    description: "Termination Bar",
                    quantity: "1",
                    unit: "ea",
                    unitPrice: "25.00",
                    notes: null,
                    sectionName: "Roof",
                    sourceType: "explicit",
                    normalizedIntent: "termination bar",
                    sourceRowIdentity: "roof:termination-bar",
                    status: "approved",
                    createdByRunId: "run-tx",
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
    const tenantDb = {
      transaction: vi.fn(async (callback: (tx: any) => Promise<any>) => callback(txDb)),
    } as any;

    const result = await promoteApprovedRecommendationsToEstimate({
      tenantDb,
      dealId: "deal-1",
      generationRunId: "run-tx",
      approvedRecommendationIds: ["rec-tx"],
    });

    expect(tenantDb.transaction).toHaveBeenCalledOnce();
    expect(result.promotedRecommendationIds).toEqual(["rec-tx"]);
    expect(estimateServiceMocks.createSection).toHaveBeenCalled();
    expect(estimateServiceMocks.createLineItem).toHaveBeenCalled();
    expect(updateReturning).toHaveBeenCalled();
  });

  it("lists approved and overridden recommendation ids for promotion", async () => {
    const selectWhere = vi.fn().mockResolvedValue([{ id: "rec-1" }, { id: "rec-2" }]);
    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: selectWhere,
        })),
      })),
    } as any;

    const result = await listApprovedRecommendationIdsForRun(tenantDb, "deal-1", "run-4");

    expect(result).toEqual(["rec-1", "rec-2"]);
    expect(selectWhere).toHaveBeenCalled();
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
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi
        .fn()
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
                    status: "approved",
                    promotedEstimateLineItemId: "line-existing",
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
          recommendationId: "rec-dup-2",
          code: "duplicate_blocked",
        }),
      ])
    );
  });

  it("keeps a requested duplicate blocked when its sibling is outside the promote request", async () => {
    const tenantDb = {
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi
        .fn()
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
                    status: "approved",
                    createdByRunId: "run-1",
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
                    status: "approved",
                    createdByRunId: "run-1",
                    promotedEstimateLineItemId: null,
                  },
                ]),
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
            returning: vi.fn().mockResolvedValue([]),
          })),
        })),
      })),
    } as any;

    const result = await promoteApprovedRecommendationsToEstimate({
      tenantDb,
      dealId: "deal-1",
      generationRunId: "run-1",
      approvedRecommendationIds: ["rec-dup-2"],
    });

    expect(estimateServiceMocks.createSection).not.toHaveBeenCalled();
    expect(estimateServiceMocks.createLineItem).not.toHaveBeenCalled();
    expect(result.promotedRecommendationIds).toEqual([]);
    expect(result.rowErrors).toEqual([
      expect.objectContaining({
        recommendationId: "rec-dup-2",
        code: "duplicate_blocked",
      }),
    ]);
  });

  it("returns an explicit row error when a requested recommendation disappears before promotion", async () => {
    estimateServiceMocks.createSection.mockResolvedValue({ id: "section-live" });
    estimateServiceMocks.createLineItem.mockResolvedValue({ id: "line-live" });
    const updateReturning = vi.fn().mockResolvedValue([{ id: "rec-live", promotedEstimateLineItemId: "line-live" }]);

    const tenantDb = {
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            innerJoin: vi.fn(() => ({
              innerJoin: vi.fn(() => ({
                where: vi.fn().mockResolvedValue([
                  {
                    recommendationId: "rec-live",
                    description: "Termination Bar",
                    quantity: "1",
                    unit: "ea",
                    unitPrice: "25.00",
                    notes: null,
                    sectionName: "Roof",
                    sourceType: "explicit",
                    selectedSourceType: "catalog_option",
                    selectedOptionId: null,
                    normalizedIntent: "termination bar",
                    sourceRowIdentity: "roof:termination-bar",
                    status: "approved",
                    createdByRunId: "run-1",
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
            returning: updateReturning,
          })),
        })),
      })),
    } as any;

    const result = await promoteApprovedRecommendationsToEstimate({
      tenantDb,
      dealId: "deal-1",
      generationRunId: "run-1",
      approvedRecommendationIds: ["rec-live", "rec-missing"],
    });

    expect(result.promotedRecommendationIds).toEqual(["rec-live"]);
    expect(result.rowErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recommendationId: "rec-missing",
          code: "recommendation_unavailable",
        }),
      ])
    );
  });

  it("carries unresolved manual rows forward into the next generation run with cloned child options", async () => {
    const recommendationInsertValues = vi.fn().mockResolvedValue([{ id: "rec-cloned-1" }]);
    const optionInsertValues = vi.fn().mockResolvedValue([{ id: "opt-cloned-1" }]);
    const recommendationUpdateReturning = vi.fn().mockResolvedValue([
      { id: "rec-cloned-1", selectedOptionId: "opt-cloned-1" },
    ]);

    const tenantDb = {
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn().mockResolvedValue([
              {
                id: "rec-source-1",
                dealId: "deal-1",
                createdByRunId: "run-old",
                sourceType: "manual",
                status: "pending_review",
                sourceRowIdentity: "manual:manual-key-1",
                manualIdentityKey: "manual-key-1",
                manualOrigin: "manual_estimator_added",
                manualLabel: "Custom flashing",
                manualQuantity: "2",
                manualUnit: "ea",
                manualUnitPrice: "75.00",
                manualNotes: "field measured",
                selectedSourceType: "catalog_option",
                selectedOptionId: "option-source-1",
                catalogBacking: "local_promoted",
                promotedLocalCatalogItemId: "local-cat-1",
                overrideQuantity: "3",
                overrideUnit: "lf",
                overrideUnitPrice: "18.00",
                overrideNotes: "override note",
                promotedEstimateLineItemId: null,
              },
            ]),
          })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn().mockResolvedValue([
              {
                id: "option-source-1",
                recommendationId: "rec-source-1",
                optionLabel: "Child catalog option",
                optionKind: "manual_custom",
                catalogItemId: null,
                localCatalogItemId: "local-cat-1",
                rank: 1,
              },
            ]),
          })),
        }),
      insert: vi
        .fn()
        .mockReturnValueOnce({
          values: recommendationInsertValues,
        })
        .mockReturnValueOnce({
          values: optionInsertValues,
        }),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: recommendationUpdateReturning,
          })),
        })),
      })),
    } as any;

    const result = await cloneManualRowsForGenerationRun({
      tenantDb,
      dealId: "deal-1",
      sourceGenerationRunId: "run-old",
      targetGenerationRunId: "run-new",
      userId: "user-1",
    });

    expect(result.clonedRecommendationIds).toEqual(["rec-cloned-1"]);
    expect(recommendationInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        dealId: "deal-1",
        createdByRunId: "run-new",
        sourceType: "manual",
        status: "pending_review",
        sourceRowIdentity: "manual:manual-key-1",
        manualIdentityKey: "manual-key-1",
        manualOrigin: "generated",
        selectedSourceType: "catalog_option",
        catalogBacking: "local_promoted",
        promotedLocalCatalogItemId: "local-cat-1",
        overrideQuantity: "3",
        overrideUnit: "lf",
        overrideUnitPrice: "18.00",
        overrideNotes: "override note",
      })
    );
    expect(optionInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        recommendationId: "rec-cloned-1",
        optionLabel: "Child catalog option",
        optionKind: "manual_custom",
        localCatalogItemId: "local-cat-1",
      })
    );
    expect(recommendationUpdateReturning).toHaveBeenCalled();
    expect(result.clonedRows).toEqual([
      expect.objectContaining({
        id: "rec-cloned-1",
        createdByRunId: "run-new",
        selectedOptionId: "opt-cloned-1",
        promotedLocalCatalogItemId: "local-cat-1",
        manualIdentityKey: "manual-key-1",
      }),
    ]);
  });
});
