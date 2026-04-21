import { describe, expect, it, vi } from "vitest";

const catalogReadModelMocks = vi.hoisted(() => ({
  resolveActiveCatalogSnapshotVersionId: vi.fn(),
  listCatalogCandidatesForMatching: vi.fn(),
}));

vi.mock("../../../src/modules/estimating/catalog-read-model-service.js", () => catalogReadModelMocks);

const { createManualEstimateRow, updateManualEstimateRow } = await import(
  "../../../src/modules/estimating/manual-row-service.js"
);

describe("manual-row-service", () => {
  it("requires an active extraction match when creating manual rows", async () => {
    await expect(
      createManualEstimateRow({
        tenantDb: {} as any,
        dealId: "deal-1",
        userId: "user-1",
        input: {
          generationRunId: "run-1",
          extractionMatchId: "",
          estimateSectionName: "Roofing",
          manualLabel: "Custom flashing",
        },
      })
    ).rejects.toThrow("Manual rows require an active extraction match");
  });

  it("uses catalog-first lookup before falling back to free-text manual rows", async () => {
    catalogReadModelMocks.resolveActiveCatalogSnapshotVersionId.mockResolvedValue("snapshot-1");
    catalogReadModelMocks.listCatalogCandidatesForMatching.mockResolvedValue([
      {
        id: "catalog-1",
        name: "Custom flashing",
        unit: "ea",
        primaryCode: "07 62 00",
        catalogBaselinePrice: "12.50",
      },
    ]);

    const insertValues = vi.fn().mockResolvedValue([{ id: "rec-1" }]);
    const updateValues = vi.fn().mockResolvedValue([{ id: "rec-1", selectedSourceType: "catalog_option" }]);
    const tenantDb = {
      insert: vi.fn(() => ({
        values: insertValues,
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: updateValues,
          })),
        })),
      })),
    } as any;
    const appDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ id: "source-1" }]),
        })),
      })),
    } as any;

    const result = await createManualEstimateRow({
      tenantDb,
      appDb,
      dealId: "deal-1",
      userId: "user-1",
      input: {
        generationRunId: "run-1",
        extractionMatchId: "match-1",
        estimateSectionName: "Roofing",
        manualLabel: "Custom flashing",
        catalogQuery: "flashing",
      },
    });

    expect(catalogReadModelMocks.resolveActiveCatalogSnapshotVersionId).toHaveBeenCalled();
    expect(catalogReadModelMocks.listCatalogCandidatesForMatching).toHaveBeenCalledWith(
      appDb,
      "source-1",
      "snapshot-1"
    );
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        extractionMatchId: "match-1",
        selectedSourceType: null,
        catalogBacking: "estimate_only",
        priceBasis: "manual_entry",
      })
    );
    expect(result.recommendation).toEqual(
      expect.objectContaining({
        selectedSourceType: null,
        catalogBacking: "estimate_only",
      })
    );
  });

  it("falls back to a free-text manual row when catalog search finds nothing", async () => {
    catalogReadModelMocks.resolveActiveCatalogSnapshotVersionId.mockResolvedValue("snapshot-1");
    catalogReadModelMocks.listCatalogCandidatesForMatching.mockResolvedValue([]);

    const insertValues = vi.fn().mockResolvedValue([{ id: "rec-2" }]);
    const tenantDb = {
      insert: vi.fn(() => ({
        values: insertValues,
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([{ id: "rec-2", selectedSourceType: null }]),
          })),
        })),
      })),
    } as any;
    const appDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ id: "source-1" }]),
        })),
      })),
    } as any;

    const result = await createManualEstimateRow({
      tenantDb,
      appDb,
      dealId: "deal-1",
      userId: "user-1",
      input: {
        generationRunId: "run-1",
        extractionMatchId: "match-1",
        estimateSectionName: "Roofing",
        manualLabel: "Custom flashing",
        catalogQuery: "missing thing",
      },
    });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        extractionMatchId: "match-1",
        selectedSourceType: null,
        catalogBacking: "estimate_only",
        priceBasis: "manual_entry",
      })
    );
    expect(result.recommendation).toEqual(
      expect.objectContaining({
        selectedSourceType: null,
        catalogBacking: "estimate_only",
      })
    );
  });

  it("downgrades an unresolved catalog-option request to a free-text manual row", async () => {
    catalogReadModelMocks.resolveActiveCatalogSnapshotVersionId.mockResolvedValue("snapshot-1");
    catalogReadModelMocks.listCatalogCandidatesForMatching.mockResolvedValue([]);

    const insertValues = vi.fn().mockResolvedValue([{ id: "rec-3" }]);
    const tenantDb = {
      insert: vi.fn(() => ({
        values: insertValues,
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([{ id: "rec-3", selectedSourceType: null }]),
          })),
        })),
      })),
    } as any;
    const appDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ id: "source-1" }]),
        })),
      })),
    } as any;

    const result = await createManualEstimateRow({
      tenantDb,
      appDb,
      dealId: "deal-1",
      userId: "user-1",
      input: {
        generationRunId: "run-1",
        extractionMatchId: "match-1",
        estimateSectionName: "Roofing",
        manualLabel: "Custom flashing",
        catalogQuery: "missing thing",
        selectedSourceType: "catalog_option",
      },
    });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        extractionMatchId: "match-1",
        selectedSourceType: null,
        selectedOptionId: null,
        catalogBacking: "estimate_only",
        priceBasis: "manual_entry",
      })
    );
    expect(result.recommendation).toEqual(
      expect.objectContaining({
        selectedSourceType: null,
        selectedOptionId: null,
        catalogBacking: "estimate_only",
      })
    );
  });

  it("does not auto-select the first catalog option when the requested stable id is missing", async () => {
    const insertValues = vi.fn().mockResolvedValue([{ id: "rec-4" }]);
    const tenantDb = {
      insert: vi.fn(() => ({
        values: insertValues,
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([{ id: "rec-4", selectedSourceType: null }]),
          })),
        })),
      })),
    } as any;

    const result = await createManualEstimateRow({
      tenantDb,
      dealId: "deal-1",
      userId: "user-1",
      input: {
        generationRunId: "run-1",
        extractionMatchId: "match-1",
        estimateSectionName: "Roofing",
        manualLabel: "Custom flashing",
        catalogOptions: [
          {
            stableId: "option-1",
            optionLabel: "First option",
            catalogItemId: "catalog-1",
          },
          {
            stableId: "option-2",
            optionLabel: "Second option",
            catalogItemId: "catalog-2",
          },
        ],
        selectedSourceType: "catalog_option",
        selectedOptionStableId: "missing-option",
      },
    });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        extractionMatchId: "match-1",
        selectedSourceType: null,
        selectedOptionId: null,
        catalogBacking: "estimate_only",
        priceBasis: "manual_entry",
      })
    );
    expect(result.recommendation).toEqual(
      expect.objectContaining({
        selectedSourceType: null,
        selectedOptionId: null,
        catalogBacking: "estimate_only",
      })
    );
  });

  it("selects a provided catalog-backed option when the stable id round-trips from the client", async () => {
    const insertValues = vi
      .fn()
      .mockResolvedValueOnce([{ id: "rec-4b" }])
      .mockResolvedValueOnce([{ id: "inserted-opt-1" }])
      .mockResolvedValueOnce([{ id: "inserted-opt-2" }]);
    const updateReturning = vi.fn().mockResolvedValue([
      {
        id: "rec-4b",
        selectedSourceType: "catalog_option",
        selectedOptionId: "inserted-opt-1",
        catalogBacking: "procore_synced",
      },
    ]);
    const tenantDb = {
      insert: vi.fn(() => ({
        values: insertValues,
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: updateReturning,
          })),
        })),
      })),
    } as any;

    const result = await createManualEstimateRow({
      tenantDb,
      dealId: "deal-1",
      userId: "user-1",
      input: {
        generationRunId: "run-1",
        extractionMatchId: "match-1",
        estimateSectionName: "Roofing",
        manualLabel: "Custom flashing",
        selectedSourceType: "catalog_option",
        selectedOptionStableId: "client-opt-1",
        catalogQuery: "flashing",
        catalogOptions: [
          {
            stableId: "client-opt-1",
            optionLabel: "Custom flashing",
            optionKind: "recommended",
            catalogItemId: "catalog-1",
          },
          {
            stableId: "client-opt-2",
            optionLabel: "Secondary flashing",
            optionKind: "alternate",
            catalogItemId: "catalog-2",
          },
        ],
      },
    });

    expect(updateReturning).toHaveBeenCalled();
    expect(result.recommendation).toEqual(
      expect.objectContaining({
        selectedSourceType: "catalog_option",
        selectedOptionId: "inserted-opt-1",
        catalogBacking: "procore_synced",
      })
    );
  });

  it("clears stale catalog selection state when switching a row back to manual mode", async () => {
    const updateSet = vi.fn(() => ({
      where: vi.fn(() => ({
        returning: updateReturning,
      })),
    }));
    const updateReturning = vi.fn().mockResolvedValue([
      {
        id: "rec-5",
        dealId: "deal-1",
        manualIdentityKey: "manual-key-5",
        manualLabel: "Custom flashing",
        manualQuantity: "2",
        manualUnit: "ea",
        manualUnitPrice: "75.00",
        manualNotes: "field measured",
        selectedSourceType: "manual",
        selectedOptionId: null,
        catalogBacking: "estimate_only",
        evidenceJson: {
          sectionName: "Roofing",
          manualLabel: "Custom flashing",
        },
      },
    ]);
    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([
              {
                id: "rec-5",
                dealId: "deal-1",
                manualIdentityKey: "manual-key-5",
                manualLabel: "Existing manual label",
                manualQuantity: "1",
                manualUnit: "ea",
                manualUnitPrice: "50.00",
                manualNotes: "existing note",
                selectedSourceType: "catalog_option",
                selectedOptionId: "opt-stale-1",
                catalogBacking: "procore_synced",
                evidenceJson: {
                  sectionName: "Roofing",
                  manualLabel: "Existing manual label",
                },
              },
            ]),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: updateSet,
      })),
      insert: vi.fn(() => ({
        values: vi.fn().mockResolvedValue([]),
      })),
    } as any;

    const result = await updateManualEstimateRow({
      tenantDb,
      dealId: "deal-1",
      recommendationId: "rec-5",
      userId: "user-1",
      input: {
        selectedSourceType: "manual",
        manualLabel: "Custom flashing",
      },
    });

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedSourceType: "manual",
        selectedOptionId: null,
        catalogBacking: "estimate_only",
      })
    );
    expect(result.recommendation).toEqual(
      expect.objectContaining({
        selectedSourceType: "manual",
        selectedOptionId: null,
        catalogBacking: "estimate_only",
      })
    );
  });
});
