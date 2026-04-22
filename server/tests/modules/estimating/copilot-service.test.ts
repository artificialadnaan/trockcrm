import { describe, expect, it, vi } from "vitest";

const copilotMocks = vi.hoisted(() => ({
  buildEstimatingWorkbenchState: vi.fn(),
  getHistoricalPricingSignals: vi.fn(),
}));

vi.mock("../../../src/modules/estimating/workbench-service.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/modules/estimating/workbench-service.js")
  >("../../../src/modules/estimating/workbench-service.js");

  return {
    ...actual,
    buildEstimatingWorkbenchState: copilotMocks.buildEstimatingWorkbenchState,
  };
});

vi.mock("../../../src/modules/estimating/historical-pricing-service.js", () => ({
  getHistoricalPricingSignals: copilotMocks.getHistoricalPricingSignals,
}));

import {
  answerEstimatingCopilotQuestion,
  buildEstimatingCopilotContext,
  getEstimatingWorkflowState,
} from "../../../src/modules/estimating/copilot-service.js";

describe("answerEstimatingCopilotQuestion", () => {
  it("returns a priced answer with evidence references", async () => {
    const result = await answerEstimatingCopilotQuestion({
      question: "What should this line item price be?",
      context: {
        historicalComparables: [{ id: "hist-1", unitPrice: 118, description: "Parapet Wall Flashing" }],
        pricingRecommendation: { recommendedUnitPrice: 121.54, priceBasis: "catalog_baseline_with_adjustments" },
      } as any,
    });

    expect(result.answer).toContain("121.54");
    expect(result.evidence.length).toBeGreaterThan(0);
  });

  it("answers a historical win-pattern question with grouped evidence", async () => {
    const result = await answerEstimatingCopilotQuestion({
      question: "What kinds of bids have we historically won?",
      context: {
        wonBidPatterns: [
          { id: "won-1", projectType: "roofing", region: "DFW", marginBand: "standard" },
          { id: "won-2", projectType: "roofing", region: "DFW", marginBand: "standard" },
        ],
      } as any,
    });

    expect(result.answer.toLowerCase()).toContain("roofing");
    expect(result.evidence.some((row: any) => row.type === "won_bid_pattern")).toBe(true);
  });
});

describe("estimating workflow state threading", () => {
  it("passes office context through to the workbench state builder", async () => {
    copilotMocks.buildEstimatingWorkbenchState.mockResolvedValueOnce({
      matchRows: [],
      marketContext: null,
    });

    const tenantDb = {} as any;
    const appDb = {} as any;

    const workflow = await getEstimatingWorkflowState(tenantDb, "deal-1", {
      appDb,
      officeId: "office-1",
    });

    expect(workflow).toEqual({ matchRows: [], marketContext: null });
    expect(copilotMocks.buildEstimatingWorkbenchState).toHaveBeenCalledWith(tenantDb, "deal-1", {
      appDb,
      officeId: "office-1",
    });
  });

  it("includes market-aware workflow state in the copilot context", async () => {
    copilotMocks.buildEstimatingWorkbenchState.mockResolvedValueOnce({
      marketContext: {
        effectiveMarket: { id: "market-tx", name: "Texas" },
        resolutionLevel: "state",
      },
      rerunStatus: {
        status: "queued",
        rerunRequestId: "rerun-1",
      },
    });
    copilotMocks.getHistoricalPricingSignals.mockResolvedValueOnce({
      historicalItems: [{ id: "hist-1", unitPrice: 118 }],
      wonBidPatterns: [{ id: "won-1", projectType: "roofing" }],
    });

    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn(() =>
                Promise.resolve([{ id: "rec-1", recommendedUnitPrice: 121.54 }])
              ),
            })),
          })),
        })),
      })),
    } as any;

    const context = await buildEstimatingCopilotContext({
      tenantDb,
      appDb: {} as any,
      dealId: "deal-1",
      officeId: "office-1",
      question: "What should this line item price be?",
    });

    expect(context.workflowState).toMatchObject({
      marketContext: {
        effectiveMarket: { id: "market-tx", name: "Texas" },
        resolutionLevel: "state",
      },
      rerunStatus: {
        status: "queued",
        rerunRequestId: "rerun-1",
      },
    });
    expect(copilotMocks.buildEstimatingWorkbenchState).toHaveBeenLastCalledWith(
      tenantDb,
      "deal-1",
      expect.objectContaining({
        officeId: "office-1",
      })
    );
  });
});
