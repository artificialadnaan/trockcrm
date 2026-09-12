import { describe, expect, it, vi } from "vitest";

const { promoteManualRowToLocalCatalog } = await import("../../../src/modules/estimating/local-catalog-service.js");

describe("local-catalog-service", () => {
  it("persists a UUID promotedLocalCatalogItemId when promoting a free-text manual row", async () => {
    const updateSet = vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn().mockImplementation(async () => [
          {
            id: "rec-1",
            dealId: "deal-1",
            sourceType: "manual",
            manualOrigin: "manual_estimator_added",
            manualIdentityKey: "manual-key-1",
            manualLabel: "Custom flashing",
            manualQuantity: "2",
            manualUnit: "ea",
            manualUnitPrice: "75.00",
            manualNotes: "field measured",
            selectedSourceType: "manual",
            selectedOptionId: null,
            catalogBacking: "local_promoted",
            promotedLocalCatalogItemId: updateSet.mock.calls[0]?.[0]?.promotedLocalCatalogItemId ?? null,
            overrideQuantity: null,
            overrideUnit: null,
            overrideUnitPrice: null,
            overrideNotes: null,
          },
        ]),
      })),
    }));
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
                  sourceType: "manual",
                  manualOrigin: "manual_estimator_added",
                  manualIdentityKey: "manual-key-1",
                  manualLabel: "Custom flashing",
                  manualQuantity: "2",
                  manualUnit: "ea",
                  manualUnitPrice: "75.00",
                  manualNotes: "field measured",
                  selectedSourceType: "manual",
                  selectedOptionId: null,
                  catalogBacking: "estimate_only",
                  promotedLocalCatalogItemId: null,
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
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([]),
            })),
          })),
        }),
      update: vi.fn(() => ({
        set: updateSet,
      })),
    } as any;

    const result = await promoteManualRowToLocalCatalog({
      tenantDb,
      dealId: "deal-1",
      recommendationId: "rec-1",
      userId: "user-1",
      input: {},
    });

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        promotedLocalCatalogItemId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        ),
      })
    );
    expect(result.recommendation.promotedLocalCatalogItemId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(result.localCatalogItem.id).toBe(result.recommendation.promotedLocalCatalogItemId);
  });

  it("reports NO default quantity for an already-promoted row that has none, rather than inventing one", async () => {
    // THE UNGUARDED EARLY RETURN. `promoteManualRowToLocalCatalog` refuses a fresh promotion without a
    // quantity (`candidateQuantity` -> 400), but the already-promoted and reused-identity paths return
    // BEFORE that check and built their synthetic catalog item straight from
    // `resolveManualPromotionValues`, whose `?? "1"` handed back a `defaultQuantity` of one unit that
    // nobody entered. A catalog entry's default seeds every future line drawn from it, so the invented
    // number does not stay in one place — it propagates. Null is the true answer.
    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([
              {
                id: "rec-promoted-1",
                dealId: "deal-1",
                sourceType: "manual",
                manualOrigin: "manual_estimator_added",
                manualIdentityKey: "manual-key-1",
                manualLabel: "Custom flashing",
                manualQuantity: null,
                manualUnit: "ea",
                manualUnitPrice: "75.00",
                manualNotes: null,
                selectedSourceType: "manual",
                selectedOptionId: null,
                catalogBacking: "estimate_only",
                promotedLocalCatalogItemId: "0f8b9a2e-1c34-4a56-8b7c-9d0e1f2a3b4c",
                overrideQuantity: null,
                overrideUnit: null,
                overrideUnitPrice: null,
                overrideNotes: null,
              },
            ]),
          })),
        })),
      })),
    } as any;

    const result = await promoteManualRowToLocalCatalog({
      tenantDb,
      dealId: "deal-1",
      recommendationId: "rec-promoted-1",
      userId: "user-1",
      input: {},
    });

    expect(result.localCatalogItem.defaultQuantity).toBeNull();
    // The rest of the item is unaffected — this is about the one field that was fabricated.
    expect(result.localCatalogItem.defaultUnitPrice).toBe("75.00");
  });

  it("rejects generated manual rows from local-catalog promotion", async () => {
    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([
              {
                id: "rec-gen-1",
                dealId: "deal-1",
                sourceType: "manual",
                manualOrigin: "generated",
                selectedSourceType: "manual",
                selectedOptionId: null,
                promotedLocalCatalogItemId: null,
              },
            ]),
          })),
        })),
      })),
    } as any;

    await expect(
      promoteManualRowToLocalCatalog({
        tenantDb,
        dealId: "deal-1",
        recommendationId: "rec-gen-1",
        userId: "user-1",
        input: {},
      })
    ).rejects.toThrow("Generated manual rows cannot be promoted to the local catalog");
  });

  it("rejects incomplete manual rows from local-catalog promotion", async () => {
    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([
              {
                id: "rec-incomplete-1",
                dealId: "deal-1",
                sourceType: "manual",
                manualOrigin: "manual_estimator_added",
                manualQuantity: null,
                manualUnitPrice: null,
                selectedSourceType: "manual",
                selectedOptionId: null,
                promotedLocalCatalogItemId: null,
              },
            ]),
          })),
        })),
      })),
    } as any;

    await expect(
      promoteManualRowToLocalCatalog({
        tenantDb,
        dealId: "deal-1",
        recommendationId: "rec-incomplete-1",
        userId: "user-1",
        input: {},
      })
    ).rejects.toThrow("Manual rows require quantity and unit price before local catalog promotion");
  });

  it("rejects manual rows that still carry catalog-backed provenance", async () => {
    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([
              {
                id: "rec-catalog-1",
                dealId: "deal-1",
                sourceType: "manual",
                manualOrigin: "manual_estimator_added",
                manualQuantity: "2",
                manualUnitPrice: "55.00",
                selectedSourceType: "manual",
                selectedOptionId: null,
                catalogBacking: "procore_synced",
                promotedLocalCatalogItemId: null,
              },
            ]),
          })),
        })),
      })),
    } as any;

    await expect(
      promoteManualRowToLocalCatalog({
        tenantDb,
        dealId: "deal-1",
        recommendationId: "rec-catalog-1",
        userId: "user-1",
        input: {},
      })
    ).rejects.toThrow("Catalog-backed manual rows are not eligible for local catalog promotion");
  });
});
