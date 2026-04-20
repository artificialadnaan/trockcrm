import { describe, expect, it, vi } from "vitest";
import {
  rejectEstimateExtractionMatch,
  selectEstimateExtractionMatch,
} from "../../../src/modules/estimating/match-review-service.js";

describe("match-review-service", () => {
  it("selects a match, resets sibling matches, and writes a review event", async () => {
    const existing = {
      id: "match-1",
      extractionId: "ext-1",
      catalogItemId: "catalog-1",
      catalogCodeId: "code-1",
      historicalLineItemId: "hist-1",
      matchType: "catalog",
      matchScore: "98.5",
      status: "suggested",
      reasonJson: { exactNameMatch: true },
      evidenceJson: { source: "catalog" },
      dealId: "deal-1",
    };
    const updated = {
      id: "match-1",
      extractionId: "ext-1",
      catalogItemId: "catalog-1",
      catalogCodeId: "code-1",
      historicalLineItemId: "hist-1",
      matchType: "catalog",
      matchScore: "98.5",
      status: "selected",
      reasonJson: { exactNameMatch: true },
      evidenceJson: { source: "catalog" },
    };
    const selectLimit = vi.fn().mockResolvedValue([existing]);
    const suggestedReturning = vi.fn().mockResolvedValue([]);
    const selectedReturning = vi.fn().mockResolvedValue([updated]);
    const insertReturning = vi.fn().mockResolvedValue([{ id: "evt-1", eventType: "selected" }]);
    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: selectLimit,
            })),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: suggestedReturning,
          })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: insertReturning,
        })),
      })),
    } as any;

    tenantDb.update
      .mockReturnValueOnce({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: suggestedReturning,
          })),
        })),
      })
      .mockReturnValueOnce({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: selectedReturning,
          })),
        })),
      });

    const result = await selectEstimateExtractionMatch({
      tenantDb,
      dealId: "deal-1",
      matchId: "match-1",
      userId: "user-1",
    });

    expect(result.match).toEqual(updated);
    expect(result.reviewEvent.eventType).toBe("selected");
    expect(tenantDb.select).toHaveBeenCalledOnce();
    expect(tenantDb.update).toHaveBeenCalledTimes(2);
    expect(insertReturning).toHaveBeenCalledOnce();
  });

  it("rejects a match with an optional reason", async () => {
    const existing = {
      id: "match-2",
      extractionId: "ext-2",
      catalogItemId: null,
      catalogCodeId: null,
      historicalLineItemId: null,
      matchType: "historical",
      matchScore: "77.0",
      status: "suggested",
      reasonJson: {},
      evidenceJson: {},
      dealId: "deal-1",
    };
    const updated = {
      id: "match-2",
      extractionId: "ext-2",
      catalogItemId: null,
      catalogCodeId: null,
      historicalLineItemId: null,
      matchType: "historical",
      matchScore: "77.0",
      status: "rejected",
      reasonJson: {},
      evidenceJson: {},
    };
    const selectLimit = vi.fn().mockResolvedValue([existing]);
    const rejectReturning = vi.fn().mockResolvedValue([updated]);
    const insertReturning = vi.fn().mockResolvedValue([{ id: "evt-2", eventType: "rejected" }]);
    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: selectLimit,
            })),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: rejectReturning,
          })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: insertReturning,
        })),
      })),
    } as any;

    const result = await rejectEstimateExtractionMatch({
      tenantDb,
      dealId: "deal-1",
      matchId: "match-2",
      userId: "user-1",
      reason: "wrong catalog item",
    });

    expect(result.match).toEqual(updated);
    expect(result.reviewEvent.eventType).toBe("rejected");
    expect(insertReturning).toHaveBeenCalledOnce();
  });

  it("throws when the match does not belong to the deal", async () => {
    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([]),
            })),
          })),
        })),
      })),
    } as any;

    await expect(
      selectEstimateExtractionMatch({
        tenantDb,
        dealId: "deal-1",
        matchId: "missing",
        userId: "user-1",
      })
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
