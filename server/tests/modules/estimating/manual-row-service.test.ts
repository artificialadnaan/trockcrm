import { describe, expect, it, vi } from "vitest";

const catalogReadModelMocks = vi.hoisted(() => ({
  resolveActiveCatalogSnapshotVersionId: vi.fn(),
  listCatalogCandidatesForMatching: vi.fn(),
}));

vi.mock("../../../src/modules/estimating/catalog-read-model-service.js", () => catalogReadModelMocks);

const { createManualEstimateRow } = await import("../../../src/modules/estimating/manual-row-service.js");

describe("manual-row-service", () => {
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
        selectedSourceType: null,
        catalogBacking: "estimate_only",
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
        estimateSectionName: "Roofing",
        manualLabel: "Custom flashing",
        catalogQuery: "missing thing",
      },
    });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedSourceType: null,
        catalogBacking: "estimate_only",
      })
    );
    expect(result.recommendation).toEqual(
      expect.objectContaining({
        selectedSourceType: null,
        catalogBacking: "estimate_only",
      })
    );
  });
});
