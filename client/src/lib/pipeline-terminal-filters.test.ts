// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  TERMINAL_STAGE_SLUGS,
  activePipelineDealValue,
  calculateActivePipelineTotal,
  excludeTerminalDeals,
  getTerminalDateFilterLabel,
  getTerminalStageOutcome,
  isTerminalStage,
  numericDealValue,
  toDatePresetRange,
  appendPipelineTerminalDateParams,
  setTerminalDateFilterSearchParams,
  readTerminalDateFiltersFromSearchParams,
  readTerminalDateFilter,
  writeTerminalDateFilter,
} from "./pipeline-terminal-filters";

describe("pipeline terminal filters", () => {
  it("identifies canonical and historical terminal stage slugs", () => {
    expect(TERMINAL_STAGE_SLUGS).toEqual([
      "won",
      "lost",
      "sent_to_production",
      "service_sent_to_production",
      "service_scheduled",
      "service_complete",
      "closed_won",
      "deal_canceled",
      "production_lost",
      "service_lost",
      "closed_lost",
    ]);

    for (const slug of TERMINAL_STAGE_SLUGS) {
      expect(isTerminalStage(slug)).toBe(true);
    }

    expect(isTerminalStage("opportunity")).toBe(false);
    expect(isTerminalStage("estimating")).toBe(false);
    expect(isTerminalStage("service_estimating")).toBe(false);
    expect(isTerminalStage("in_production", "normal")).toBe(false);
    expect(isTerminalStage("close_out", "normal")).toBe(false);
    expect(isTerminalStage("service_scheduled")).toBe(true);
    expect(isTerminalStage("service_complete")).toBe(true);
    expect(getTerminalStageOutcome("service_sent_to_production")).toBe("won");
    expect(getTerminalStageOutcome("service_scheduled")).toBe("won");
    expect(getTerminalStageOutcome("service_complete")).toBe("won");
    expect(getTerminalStageOutcome("in_production", "normal")).toBe(null);
    expect(getTerminalStageOutcome("close_out", "normal")).toBe(null);
    expect(getTerminalStageOutcome("deal_canceled")).toBe("lost");
    expect(getTerminalStageOutcome("service_lost")).toBe("lost");
    expect(getTerminalStageOutcome("opportunity")).toBe(null);
  });

  it("filters terminal deals and keeps active pipeline deals", () => {
    const deals = [
      { id: "active-1", stageSlug: "opportunity", value: 100_000 },
      { id: "won-1", stageSlug: "won", value: 400_000 },
      { id: "lost-1", stageSlug: "service_lost", value: 50_000 },
      { id: "transition-1", stageSlug: "in_production", value: 125_000 },
      { id: "transition-2", stageSlug: "close_out", value: 135_000 },
      { id: "active-2", stageSlug: "estimate_sent_to_client", value: 75_000 },
    ];

    expect(excludeTerminalDeals(deals).map((deal) => deal.id)).toEqual([
      "active-1",
      "transition-1",
      "transition-2",
      "active-2",
    ]);
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

  it("uses the current bid value before awarded amount for active pipeline value", () => {
    expect(activePipelineDealValue({ awardedAmount: 0, bidEstimate: 50_000, ddEstimate: 30_000 })).toBe(50_000);
    expect(activePipelineDealValue({ awardedAmount: 2.97, bidEstimate: 16_137.14, ddEstimate: 3 })).toBe(16_137.14);
    expect(activePipelineDealValue({ awardedAmount: null, bidEstimate: 50_000, ddEstimate: 30_000 })).toBe(50_000);
    expect(activePipelineDealValue({ awardedAmount: null, bidEstimate: null, ddEstimate: 30_000 })).toBe(30_000);
    expect(activePipelineDealValue({ awardedAmount: null, bidEstimate: null, ddEstimate: null })).toBe(0);
  });

  it("treats whitespace-only strings as missing values instead of explicit zero", () => {
    expect(numericDealValue("  ")).toBeNull();
    expect(numericDealValue("")).toBeNull();
    expect(numericDealValue(null)).toBeNull();
    expect(numericDealValue("0")).toBe(0);
    expect(numericDealValue("0.00")).toBe(0);
    expect(numericDealValue("100")).toBe(100);
    expect(numericDealValue(" 100 ")).toBe(100);
  });

  it("falls back past whitespace-only awarded and bid values", () => {
    expect(activePipelineDealValue({ awardedAmount: "  ", bidEstimate: "120000", ddEstimate: "80000" })).toBe(
      120_000
    );
    expect(activePipelineDealValue({ awardedAmount: " ", bidEstimate: " ", ddEstimate: "80000" })).toBe(80_000);
  });
});

describe("week-to-date (Sunday-anchored) preset", () => {
  // WTD is Sunday-anchored on the user's LOCAL calendar (their week for the Sunday meeting).
  it("spans the most recent Sunday through a midweek reference day", () => {
    const now = new Date(2026, 4, 27); // Wednesday; the most recent Sunday is 2026-05-24.
    expect(toDatePresetRange("wtd", now)).toEqual({ from: "2026-05-24", to: "2026-05-27" });
  });

  it("collapses to a single day when the reference day is itself a Sunday", () => {
    const now = new Date(2026, 4, 24); // Sunday.
    expect(toDatePresetRange("wtd", now)).toEqual({ from: "2026-05-24", to: "2026-05-24" });
  });

  it("crosses a month boundary back to the prior Sunday", () => {
    const now = new Date(2026, 2, 3); // Tuesday after Sunday 2026-03-01.
    expect(toDatePresetRange("wtd", now)).toEqual({ from: "2026-03-01", to: "2026-03-03" });
  });

  it("labels the wtd preset as WTD", () => {
    expect(getTerminalDateFilterLabel({ preset: "wtd" })).toBe("WTD");
  });

  it("round-trips the wtd preset through localStorage (readTerminalDateFilter parse allow-list)", () => {
    writeTerminalDateFilter("won", { preset: "wtd" });
    expect(readTerminalDateFilter("won")).toEqual({ preset: "wtd" });
  });

  it("serializes wtd as a since/until window without throwing", () => {
    const params = new URLSearchParams();
    appendPipelineTerminalDateParams(params, { won: { preset: "wtd" }, lost: { preset: "all" } });
    const since = params.get("won_since");
    const until = params.get("won_until");
    expect(since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(until).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(since! <= until!).toBe(true);
  });

  it("round-trips the wtd preset through search params", () => {
    const params = new URLSearchParams();
    setTerminalDateFilterSearchParams(params, "won", { preset: "wtd" });
    expect(params.get("won_preset")).toBe("wtd");
    expect(readTerminalDateFiltersFromSearchParams(params).won).toEqual({ preset: "wtd" });
  });
});
