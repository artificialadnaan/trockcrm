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
  resolveDatePreset,
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

  it("uses awarded amount before the current bid value for active pipeline value (unified awarded-first 2026-06-18)", () => {
    expect(activePipelineDealValue({ awardedAmount: 0, bidEstimate: 50_000, ddEstimate: 30_000 })).toBe(50_000); // awarded 0 = unset
    expect(activePipelineDealValue({ awardedAmount: 2.97, bidEstimate: 16_137.14, ddEstimate: 3 })).toBe(2.97); // awarded wins
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
  // WTD is the BUSINESS's Sunday-anchored week in Central time (matching server F1) -- so a rep in any
  // timezone sees the office's week. Instants are explicit UTC (18:00Z = 13:00 CT, same calendar day) so
  // the assertions are deterministic regardless of the test runner's local timezone.
  it("spans the most recent Sunday through a midweek reference day", () => {
    const now = new Date("2026-05-27T18:00:00Z"); // Wednesday in CT; most recent Sunday is 2026-05-24.
    expect(toDatePresetRange("wtd", now)).toEqual({ from: "2026-05-24", to: "2026-05-27" });
  });

  it("collapses to a single day when the reference day is itself a Sunday", () => {
    const now = new Date("2026-05-24T18:00:00Z"); // Sunday in CT.
    expect(toDatePresetRange("wtd", now)).toEqual({ from: "2026-05-24", to: "2026-05-24" });
  });

  it("crosses a month boundary back to the prior Sunday", () => {
    const now = new Date("2026-03-03T18:00:00Z"); // Tuesday in CT after Sunday 2026-03-01.
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

describe("resolveDatePreset (canonical platform-wide date-preset resolver)", () => {
  // Wed 2026-03-18 (13:00 CT); most recent Sunday is 2026-03-15. All boundaries are CENTRAL (matching F1).
  const now = new Date("2026-03-18T18:00:00Z");

  it("resolves every preset to a CENTRAL-calendar window with an inclusive today bound", () => {
    expect(resolveDatePreset("today", now)).toEqual({ from: "2026-03-18", to: "2026-03-18" });
    expect(resolveDatePreset("wtd", now)).toEqual({ from: "2026-03-15", to: "2026-03-18" });
    expect(resolveDatePreset("mtd", now)).toEqual({ from: "2026-03-01", to: "2026-03-18" });
    expect(resolveDatePreset("qtd", now)).toEqual({ from: "2026-01-01", to: "2026-03-18" });
    expect(resolveDatePreset("ytd", now)).toEqual({ from: "2026-01-01", to: "2026-03-18" });
    expect(resolveDatePreset("last_month", now)).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(resolveDatePreset("last_quarter", now)).toEqual({ from: "2025-10-01", to: "2025-12-31" });
    expect(resolveDatePreset("last_year", now)).toEqual({ from: "2025-01-01", to: "2025-12-31" });
  });

  it("anchors to the BUSINESS (Central) calendar day, not the runner's local/UTC day", () => {
    // 2026-03-02 04:30Z = 2026-03-01 22:30 CT: month-to-date is the Central March, not the UTC March 2.
    const lateCt = new Date("2026-03-02T04:30:00Z");
    expect(resolveDatePreset("mtd", lateCt)).toEqual({ from: "2026-03-01", to: "2026-03-01" });
  });

  // RECONCILIATION with server F1 (server/src/lib/period.ts) at the cross-tz boundary -- the case the
  // platform decision is about: F1 is canonical (Central), the client aligns to it.
  it("matches F1's Central week at the cross-timezone boundary (Pacific-Saturday but Central-Sunday)", () => {
    // 2026-05-31T05:30:00Z = 00:30 Sunday CT, but 22:30 Saturday in US/Pacific. The Central week has
    // already rolled to the new Sunday -- so WTD collapses to 2026-05-31, identical to F1.getWtdPeriod
    // ("to_date") for the same instant (locked in server/tests/lib/period.test.ts).
    const ctSundayPacificSaturday = new Date("2026-05-31T05:30:00Z");
    expect(resolveDatePreset("wtd", ctSundayPacificSaturday)).toEqual({ from: "2026-05-31", to: "2026-05-31" });
    // and one tick earlier (still Central-Saturday) it stays in the prior week, also matching F1.
    const stillCtSaturday = new Date("2026-05-31T02:00:00Z"); // 21:00 Saturday CT
    expect(resolveDatePreset("wtd", stillCtSaturday)).toEqual({ from: "2026-05-24", to: "2026-05-30" });
  });

  it("is the single source toDatePresetRange delegates to (identical output)", () => {
    for (const preset of ["wtd", "mtd", "qtd", "ytd"] as const) {
      expect(toDatePresetRange(preset, now)).toEqual(resolveDatePreset(preset, now));
    }
  });
});
