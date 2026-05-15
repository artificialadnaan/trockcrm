import { describe, expect, it } from "vitest";
import {
  TERMINAL_STAGE_SLUGS,
  calculateActivePipelineTotal,
  excludeTerminalDeals,
  getTerminalStageOutcome,
  isTerminalStage,
} from "./pipeline-terminal-filters";

describe("pipeline terminal filters", () => {
  it("identifies canonical and historical terminal stage slugs", () => {
    expect(TERMINAL_STAGE_SLUGS).toEqual(
      expect.arrayContaining([
        "won",
        "lost",
        "sent_to_production",
        "service_sent_to_production",
        "closed_won",
        "production_lost",
        "service_lost",
        "closed_lost",
      ])
    );

    for (const slug of TERMINAL_STAGE_SLUGS) {
      expect(isTerminalStage(slug)).toBe(true);
    }

    expect(isTerminalStage("opportunity")).toBe(false);
    expect(isTerminalStage("estimating")).toBe(false);
    expect(isTerminalStage("service_estimating")).toBe(false);
    expect(getTerminalStageOutcome("service_sent_to_production")).toBe("won");
    expect(getTerminalStageOutcome("service_lost")).toBe("lost");
    expect(getTerminalStageOutcome("opportunity")).toBe(null);
  });

  it("filters terminal deals and keeps active pipeline deals", () => {
    const deals = [
      { id: "active-1", stageSlug: "opportunity", value: 100_000 },
      { id: "won-1", stageSlug: "won", value: 400_000 },
      { id: "lost-1", stageSlug: "service_lost", value: 50_000 },
      { id: "active-2", stageSlug: "estimate_sent_to_client", value: 75_000 },
    ];

    expect(excludeTerminalDeals(deals).map((deal) => deal.id)).toEqual(["active-1", "active-2"]);
  });

  it("calculates active pipeline amount and count without terminal deals", () => {
    const deals = [
      { stageSlug: "opportunity", awardedAmount: null, bidEstimate: "100000", ddEstimate: null },
      { stageSlug: "won", awardedAmount: "450000", bidEstimate: null, ddEstimate: null },
      { stageSlug: "closed_lost", awardedAmount: null, bidEstimate: "25000", ddEstimate: null },
      { stageSlug: "opportunity", bidBoardStageSlug: "service_sent_to_production", bidEstimate: "900000" },
      { stageSlug: "service_estimating", awardedAmount: null, bidEstimate: null, ddEstimate: "80000" },
    ];

    expect(calculateActivePipelineTotal(deals)).toEqual({ amount: 180_000, count: 2 });
  });
});
