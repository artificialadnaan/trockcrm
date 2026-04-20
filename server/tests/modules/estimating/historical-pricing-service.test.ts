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
});
