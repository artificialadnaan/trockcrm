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
  it("builds nested summary counts and promotion readiness from eligible pricing rows", async () => {
    const tenantDb = makeTenantDb([
      [
        { id: "doc-1", ocrStatus: "queued" },
        { id: "doc-2", ocrStatus: "failed" },
        { id: "doc-3", ocrStatus: "queued" },
      ],
      [
        { id: "ext-1", status: "pending" },
        { id: "ext-2", status: "approved" },
        { id: "ext-3", status: "rejected" },
        { id: "ext-4", status: "unmatched" },
      ],
      [
        { id: "match-1", status: "suggested" },
        { id: "match-2", status: "selected" },
        { id: "match-3", status: "rejected" },
      ],
      [
        { id: "rec-1", status: "pending", createdByRunId: "run-pending" },
        { id: "rec-2", status: "approved", createdByRunId: "run-approved-1" },
        { id: "rec-3", status: "overridden", createdByRunId: "run-approved-1" },
        { id: "rec-4", status: "overridden", createdByRunId: "run-approved-2" },
        { id: "rec-5", status: "rejected", createdByRunId: "run-rejected" },
      ],
      [{ id: "event-1" }],
    ]);

    const state = await buildEstimatingWorkbenchState(tenantDb, "deal-1");

    expect(state.summary).toEqual({
      documents: {
        total: 3,
        queued: 2,
        failed: 1,
      },
      extractions: {
        total: 4,
        pending: 1,
        approved: 1,
        rejected: 1,
        unmatched: 1,
      },
      matches: {
        total: 3,
        suggested: 1,
        selected: 1,
        rejected: 1,
      },
      pricing: {
        total: 5,
        pending: 1,
        approved: 1,
        overridden: 2,
        rejected: 1,
        readyToPromote: true,
      },
    });
    expect(state.promotionReadiness).toEqual({
      canPromote: true,
      generationRunIds: ["run-approved-1", "run-approved-2"],
    });
    expect(state.documents).toHaveLength(3);
    expect(state.pricingRows).toHaveLength(5);
  });

  it("keeps promotion disabled when no approved or overridden recommendations exist", async () => {
    const tenantDb = makeTenantDb([[], [], [], [{ id: "rec-1", status: "pending" }], []]);

    const state = await buildEstimatingWorkbenchState(tenantDb, "deal-1");

    expect(state.summary).toEqual({
      documents: {
        total: 0,
        queued: 0,
        failed: 0,
      },
      extractions: {
        total: 0,
        pending: 0,
        approved: 0,
        rejected: 0,
        unmatched: 0,
      },
      matches: {
        total: 0,
        suggested: 0,
        selected: 0,
        rejected: 0,
      },
      pricing: {
        total: 1,
        pending: 1,
        approved: 0,
        overridden: 0,
        rejected: 0,
        readyToPromote: false,
      },
    });
    expect(state.promotionReadiness).toEqual({
      canPromote: false,
      generationRunIds: [],
    });
  });
});
