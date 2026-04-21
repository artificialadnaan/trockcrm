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
});
