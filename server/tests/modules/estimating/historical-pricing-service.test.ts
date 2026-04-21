import { describe, expect, it, vi } from "vitest";
import { getHistoricalPricingSignals } from "../../../src/modules/estimating/historical-pricing-service.js";

describe("getHistoricalPricingSignals", () => {
  it("excludes the current deal from historical line item comparisons", async () => {
    const historicalWhere = vi.fn(() => ({
      orderBy: vi.fn(() => ({
        limit: vi.fn().mockResolvedValue([]),
      })),
    }));

    const tenantDb = {
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([{ id: "deal-1", regionId: "dfw", projectTypeId: "roofing" }]),
            })),
          })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            innerJoin: vi.fn(() => ({
              where: historicalWhere,
            })),
          })),
        }),
    } as any;

    const result = await getHistoricalPricingSignals(tenantDb, "deal-1");

    expect(result.currentDeal?.id).toBe("deal-1");
    expect(historicalWhere).toHaveBeenCalled();
  });

  it("falls back to related property geography when the deal geography is blank", async () => {
    const historicalWhere = vi.fn(() => ({
      orderBy: vi.fn(() => ({
        limit: vi.fn().mockResolvedValue([]),
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
                  id: "deal-1",
                  projectTypeId: "roofing",
                  regionId: "region-1",
                  propertyId: "property-1",
                  propertyZip: null,
                  propertyState: null,
                  resolvedZip: null,
                  resolvedState: null,
                },
              ]),
            })),
          })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([
                {
                  zip: "76102",
                  state: "TX",
                },
              ]),
            })),
          })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            innerJoin: vi.fn(() => ({
              where: historicalWhere,
            })),
          })),
        }),
    } as any;

    const result = await getHistoricalPricingSignals(tenantDb, "deal-1");

    expect(result.currentDeal?.resolvedZip).toBe("76102");
    expect(result.currentDeal?.resolvedState).toBe("TX");
    expect(result.currentDeal?.propertyZip).toBe("76102");
    expect(result.currentDeal?.propertyState).toBe("TX");
  });
});
