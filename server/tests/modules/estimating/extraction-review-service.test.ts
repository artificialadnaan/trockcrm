import { describe, expect, it, vi } from "vitest";
import {
  approveEstimateExtraction,
  rejectEstimateExtraction,
  updateEstimateExtraction,
} from "../../../src/modules/estimating/extraction-review-service.js";

describe("extraction-review-service", () => {
  it("marks an extraction approved and writes a review event", async () => {
    const updatedRow = { id: "ext-1", status: "approved" };
    const updateReturning = vi.fn().mockResolvedValue([updatedRow]);
    const insertReturning = vi.fn().mockResolvedValue([{ id: "evt-1", eventType: "approved" }]);
    const tenantDb = {
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

    const result = await approveEstimateExtraction({
      tenantDb,
      dealId: "deal-1",
      extractionId: "ext-1",
      userId: "user-1",
    });

    expect(result.extraction).toEqual(updatedRow);
    expect(result.reviewEvent.eventType).toBe("approved");
    expect(tenantDb.update).toHaveBeenCalledOnce();
    expect(tenantDb.insert).toHaveBeenCalledOnce();
  });

  it("rejects an extraction with an optional reason", async () => {
    const updatedRow = { id: "ext-2", status: "rejected" };
    const updateReturning = vi.fn().mockResolvedValue([updatedRow]);
    const insertReturning = vi.fn().mockResolvedValue([{ id: "evt-2", eventType: "rejected" }]);
    const tenantDb = {
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

    const result = await rejectEstimateExtraction({
      tenantDb,
      dealId: "deal-1",
      extractionId: "ext-2",
      userId: "user-1",
      reason: "duplicate scope line",
    });

    expect(result.extraction).toEqual(updatedRow);
    expect(result.reviewEvent.eventType).toBe("rejected");
    expect(tenantDb.insert).toHaveBeenCalledOnce();
  });

  it("updates an extraction and logs before and after values", async () => {
    const existing = {
      id: "ext-3",
      normalizedLabel: "Old Label",
      quantity: "1.000",
      unit: "ea",
      divisionHint: "05",
    };
    const updatedRow = {
      id: "ext-3",
      normalizedLabel: "New Label",
      quantity: "2.000",
      unit: "ft",
      divisionHint: "07",
    };
    const selectLimit = vi.fn().mockResolvedValue([existing]);
    const updateReturning = vi.fn().mockResolvedValue([updatedRow]);
    const insertReturning = vi.fn().mockResolvedValue([{ id: "evt-3", eventType: "edited" }]);
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

    const result = await updateEstimateExtraction({
      tenantDb,
      dealId: "deal-1",
      extractionId: "ext-3",
      userId: "user-1",
      input: {
        normalizedLabel: "New Label",
        quantity: "2.000",
        unit: "ft",
        divisionHint: "07",
      },
    });

    expect(result.extraction).toEqual(updatedRow);
    expect(result.reviewEvent.eventType).toBe("edited");
    expect(insertReturning).toHaveBeenCalledWith();
  });
});
