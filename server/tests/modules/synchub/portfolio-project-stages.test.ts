import { describe, expect, it } from "vitest";
import {
  PORTFOLIO_PROJECT_BOARD_STAGES,
  isPortfolioProjectBoardStage,
  normalizePortfolioProjectStage,
} from "@trock-crm/shared/types";

describe("portfolio project stage normalization", () => {
  it.each([
    ["Bidding", "bidding"],
    ["BID", "bidding"],
    ["Buy Out", "buyout"],
    ["Buy-Out", "buyout"],
    ["buy_out", "buyout"],
    ["Close Out", "close out"],
    ["Close-Out", "close out"],
    ["closeout", "close out"],
    ["Close Out - Final Invoice", "close out - final invoice"],
    ["Close-Out - Final Invoice", "close out - final invoice"],
    ["Close-Out-Final Invoice", "close out - final invoice"],
    ["closeout final invoice", "close out - final invoice"],
    ["Closed", "closed"],
    ["Contract Executed", "contract executed"],
    ["contracts executed", "contract executed"],
    ["In Production", "in production"],
    ["production", "in production"],
  ])("maps %s to canonical board stage %s", (input, expected) => {
    expect(normalizePortfolioProjectStage(input)).toBe(expected);
    expect(isPortfolioProjectBoardStage(input)).toBe(true);
  });

  it("keeps all canonical board stages board-relevant", () => {
    for (const stage of PORTFOLIO_PROJECT_BOARD_STAGES) {
      expect(normalizePortfolioProjectStage(stage)).toBe(stage);
      expect(isPortfolioProjectBoardStage(stage)).toBe(true);
    }
  });
});
