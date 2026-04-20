import { describe, expect, it, vi } from "vitest";
import {
  answerEstimatingCopilotQuestion,
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

  it("scopes catalog matches to the current deal", async () => {
    const matchesWhere = vi.fn().mockReturnValue({
      orderBy: vi.fn().mockResolvedValue([]),
    });
    const matchesInnerJoin = vi.fn(() => ({
      where: matchesWhere,
    }));
    const tenantDb = {
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn().mockResolvedValue([]),
            })),
          })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn().mockResolvedValue([]),
            })),
          })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            innerJoin: matchesInnerJoin,
          })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn().mockResolvedValue([]),
            })),
          })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn().mockResolvedValue([]),
            })),
          })),
        }),
    } as any;

    const workflow = await getEstimatingWorkflowState(tenantDb, "deal-1");

    expect(workflow.matchRows).toEqual([]);
    expect(matchesInnerJoin).toHaveBeenCalled();
    expect(matchesWhere).toHaveBeenCalled();
  });
});
