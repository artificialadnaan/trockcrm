import { describe, expect, it } from "vitest";
import {
  PORTFOLIO_PROJECT_BOARD_STAGES,
  PORTFOLIO_PROJECT_OFF_BOARD_STAGES,
  isPortfolioProjectBoardRelevantStage,
  isPortfolioProjectBoardStage,
  isPortfolioProjectOffBoardStage,
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

  it("normalizes every canonical stage to ITSELF (double-normalization is a no-op)", () => {
    // The relay normalizes and then re-classifies the already-normalized value, so a canonical
    // stage that did not survive a second pass would silently lose its column.
    for (const stage of [...PORTFOLIO_PROJECT_BOARD_STAGES, ...PORTFOLIO_PROJECT_OFF_BOARD_STAGES]) {
      expect(normalizePortfolioProjectStage(normalizePortfolioProjectStage(stage))).toBe(stage);
    }
  });
});

/**
 * The 16 stage strings actually present in SyncHub's `public.procore_projects` for active
 * projects, copied VERBATIM from a live census — including the trailing space Procore stores
 * on "Estimating ". Every one of them must land somewhere deliberate.
 */
const LIVE_PROCORE_STAGES: Array<{
  raw: string;
  normalized: string;
  placement: "board" | "off-board";
}> = [
  { raw: "Hold (LEGACY)", normalized: "hold (legacy)", placement: "off-board" },
  { raw: "Lost/Cancelled (Legacy)", normalized: "lost/cancelled (legacy)", placement: "off-board" },
  { raw: "Service - Close Out Final Invoice", normalized: "service - close out final invoice", placement: "board" },
  { raw: "Closed", normalized: "closed", placement: "board" },
  { raw: "Close Out - Final Invoice", normalized: "close out - final invoice", placement: "board" },
  { raw: "In Production", normalized: "in production", placement: "board" },
  { raw: "Service - In Production", normalized: "service - in production", placement: "board" },
  { raw: "Buy Out", normalized: "buyout", placement: "board" },
  { raw: "Pre-Construction", normalized: "pre-construction", placement: "board" },
  { raw: "Estimating ", normalized: "estimating", placement: "board" }, // NOTE: trailing space in Procore
  { raw: "Service - Close Out", normalized: "service - close out", placement: "board" },
  { raw: "Close Out", normalized: "close out", placement: "board" },
  { raw: "Service - Lost", normalized: "service - lost", placement: "board" },
  { raw: "Service - Estimating", normalized: "service - estimating", placement: "board" },
  { raw: "Bidding", normalized: "bidding", placement: "board" },
  { raw: "Contract Executed", normalized: "contract executed", placement: "board" },
];

describe("every live Procore stage is mapped on purpose", () => {
  it.each(LIVE_PROCORE_STAGES.map((row) => [row.raw, row.normalized, row.placement] as const))(
    "%j normalizes to %j and is %s",
    (raw, normalized, placement) => {
      expect(normalizePortfolioProjectStage(raw)).toBe(normalized);
      expect(isPortfolioProjectBoardStage(raw)).toBe(placement === "board");
      expect(isPortfolioProjectOffBoardStage(raw)).toBe(placement === "off-board");
      // Off-board stages are the ONLY ones excluded from ingestion.
      expect(isPortfolioProjectBoardRelevantStage(raw)).toBe(placement === "off-board" ? false : true);
    },
  );

  it("covers all 16 live stages, so none can fall through the alias map by accident", () => {
    expect(LIVE_PROCORE_STAGES).toHaveLength(16);
    const unclassified = LIVE_PROCORE_STAGES.filter(
      (row) => !isPortfolioProjectBoardStage(row.raw) && !isPortfolioProjectOffBoardStage(row.raw),
    );
    expect(unclassified).toEqual([]);
  });

  it("trims Procore's trailing space rather than minting a separate stage", () => {
    expect(normalizePortfolioProjectStage("Estimating ")).toBe(
      normalizePortfolioProjectStage("Estimating"),
    );
  });

  it("keeps the service final-invoice stage distinct from the construction one", () => {
    // Procore punctuates these differently: no hyphen before "Final" on the service stage.
    expect(normalizePortfolioProjectStage("Service - Close Out Final Invoice")).not.toBe(
      normalizePortfolioProjectStage("Close Out - Final Invoice"),
    );
    expect(normalizePortfolioProjectStage("Service - Close Out Final Invoice")).not.toBe(
      normalizePortfolioProjectStage("Service - Close Out"),
    );
  });
});

describe("stages nobody anticipated", () => {
  it("stays board-relevant so it is ingested and surfaced instead of dropped", () => {
    const surprise = "Warranty - Punch List";
    expect(isPortfolioProjectBoardStage(surprise)).toBe(false);
    expect(isPortfolioProjectOffBoardStage(surprise)).toBe(false);
    // The load-bearing bit: unknown != excluded.
    expect(isPortfolioProjectBoardRelevantStage(surprise)).toBe(true);
    expect(normalizePortfolioProjectStage(surprise)).toBe("warranty - punch list");
  });

  it("treats an absent stage as unknown-but-relevant, never as a decision to exclude", () => {
    for (const value of [null, undefined, ""]) {
      expect(isPortfolioProjectOffBoardStage(value)).toBe(false);
      expect(isPortfolioProjectBoardRelevantStage(value)).toBe(true);
    }
  });

  it("excludes ONLY the two explicitly listed legacy stages", () => {
    expect([...PORTFOLIO_PROJECT_OFF_BOARD_STAGES]).toEqual([
      "hold (legacy)",
      "lost/cancelled (legacy)",
    ]);
    for (const stage of PORTFOLIO_PROJECT_OFF_BOARD_STAGES) {
      expect(isPortfolioProjectBoardRelevantStage(stage)).toBe(false);
      expect(isPortfolioProjectBoardStage(stage)).toBe(false);
    }
  });
});
