import { describe, expect, it, vi } from "vitest";
import {
  approveEstimatePricingRecommendation,
  rejectEstimatePricingRecommendation,
  overrideEstimatePricingRecommendation,
} from "../../../src/modules/estimating/pricing-review-service.js";

describe("pricing-review-service", () => {
  it("approves a pricing recommendation and writes a review event", async () => {
    const existing = {
      id: "rec-1",
      dealId: "deal-1",
      recommendedUnitPrice: "121.50",
      recommendedTotalPrice: "364.50",
      status: "pending",
    };
    const updated = { ...existing, status: "approved" };
    const selectLimit = vi.fn().mockResolvedValue([existing]);
    const updateReturning = vi.fn().mockResolvedValue([updated]);
    const insertReturning = vi.fn().mockResolvedValue([{ id: "evt-1", eventType: "approved" }]);
    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: selectLimit,
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

    const result = await approveEstimatePricingRecommendation({
      tenantDb,
      dealId: "deal-1",
      recommendationId: "rec-1",
      userId: "user-1",
    });

    expect(result.recommendation).toEqual(updated);
    expect(result.reviewEvent.eventType).toBe("approved");
    expect(insertReturning).toHaveBeenCalledOnce();
  });

  it("rejects a pricing recommendation with an optional reason", async () => {
    const existing = {
      id: "rec-2",
      dealId: "deal-1",
      recommendedUnitPrice: "150.00",
      recommendedTotalPrice: "450.00",
      status: "pending",
    };
    const updated = { ...existing, status: "rejected" };
    const selectLimit = vi.fn().mockResolvedValue([existing]);
    const updateReturning = vi.fn().mockResolvedValue([updated]);
    const insertReturning = vi.fn().mockResolvedValue([{ id: "evt-2", eventType: "rejected" }]);
    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: selectLimit,
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

    const result = await rejectEstimatePricingRecommendation({
      tenantDb,
      dealId: "deal-1",
      recommendationId: "rec-2",
      userId: "user-1",
      reason: "not aligned with scope",
    });

    expect(result.recommendation).toEqual(updated);
    expect(result.reviewEvent.eventType).toBe("rejected");
    expect(insertReturning).toHaveBeenCalledOnce();
  });

  it("overrides a pricing recommendation and enforces an override reason", async () => {
    const existing = {
      id: "rec-3",
      dealId: "deal-1",
      recommendedUnitPrice: "90.00",
      recommendedTotalPrice: "270.00",
      status: "approved",
    };
    const updated = {
      ...existing,
      recommendedUnitPrice: "95.00",
      recommendedTotalPrice: "285.00",
      status: "overridden",
    };
    const selectLimit = vi.fn().mockResolvedValue([existing]);
    const updateReturning = vi.fn().mockResolvedValue([updated]);
    const insertReturning = vi.fn().mockResolvedValue([{ id: "evt-3", eventType: "overridden" }]);
    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: selectLimit,
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

    const result = await overrideEstimatePricingRecommendation({
      tenantDb,
      dealId: "deal-1",
      recommendationId: "rec-3",
      userId: "user-1",
      input: {
        recommendedUnitPrice: "95.00",
        recommendedTotalPrice: "285.00",
        reason: "site conditions changed",
      },
    });

    expect(result.recommendation).toEqual(updated);
    expect(result.reviewEvent.eventType).toBe("overridden");
    expect(insertReturning).toHaveBeenCalledOnce();
  });

  it("requires an override reason", async () => {
    await expect(
      overrideEstimatePricingRecommendation({
        tenantDb: {} as any,
        dealId: "deal-1",
        recommendationId: "rec-4",
        userId: "user-1",
        input: {
          recommendedUnitPrice: "95.00",
          recommendedTotalPrice: "285.00",
          reason: "   ",
        },
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
