import { describe, expect, it, vi } from "vitest";
import { buildEstimatingWorkbenchState } from "../../../src/modules/estimating/workbench-service.js";

function makeQueryResult(resolved: any) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        orderBy: vi.fn().mockResolvedValue(resolved),
      })),
    })),
  };
}

function makeJoinQueryResult(resolved: any) {
  return {
    from: vi.fn(() => ({
      innerJoin: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn().mockResolvedValue(resolved),
        })),
      })),
    })),
  };
}

function makeTenantDb(results: any[]) {
  return {
    select: vi.fn()
      .mockReturnValueOnce(makeQueryResult(results[0]))
      .mockReturnValueOnce(makeQueryResult(results[1]))
      .mockReturnValueOnce(makeJoinQueryResult(results[2]))
      .mockReturnValueOnce(makeQueryResult(results[3]))
      .mockReturnValueOnce(makeQueryResult(results[4])),
  } as any;
}

describe("buildEstimatingWorkbenchState", () => {
  it("builds summary counts and marks promotion ready when recommendations are approved", async () => {
    const tenantDb = makeTenantDb([
      [{ id: "doc-1" }, { id: "doc-2" }],
      [{ id: "ext-1" }, { id: "ext-2" }, { id: "ext-3" }],
      [{ id: "match-1" }, { id: "match-2" }, { id: "match-3" }, { id: "match-4" }],
      [
        { id: "rec-1", status: "pending" },
        { id: "rec-2", status: "approved" },
        { id: "rec-3", status: "approved" },
      ],
      [{ id: "event-1" }],
    ]);

    const state = await buildEstimatingWorkbenchState(tenantDb, "deal-1");

    expect(state.summary).toEqual({
      documentCount: 2,
      extractionCount: 3,
      matchCount: 4,
      recommendationCount: 3,
      approvedRecommendationCount: 2,
      reviewEventCount: 1,
    });
    expect(state.promotionReady).toBe(true);
    expect(state.documents).toHaveLength(2);
    expect(state.pricingRows).toHaveLength(3);
  });

  it("keeps promotion disabled when no approved recommendations exist", async () => {
    const tenantDb = makeTenantDb([[], [], [], [{ id: "rec-1", status: "pending" }], []]);

    const state = await buildEstimatingWorkbenchState(tenantDb, "deal-1");

    expect(state.summary).toEqual({
      documentCount: 0,
      extractionCount: 0,
      matchCount: 0,
      recommendationCount: 1,
      approvedRecommendationCount: 0,
      reviewEventCount: 0,
    });
    expect(state.promotionReady).toBe(false);
  });
});
