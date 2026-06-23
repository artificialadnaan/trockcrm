import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getEffectiveDealValue } from "@trock-crm/shared/types";
import {
  aliasedActiveDealCountFilterSql,
  aliasedReportableDealFilterSql,
  aliasedDealAwardedAmountSql,
  aliasedEffectiveAwardedDealValueSql,
  aliasedEffectiveWonDealValueSql,
  aliasedDealAwardedFirstWithFallbackSql,
  aliasedDealBestEstimateSql,
  aliasedDealBestEstimateWithForecastSql,
  aliasedDealEstimatingValueSql,
  aliasedEffectiveDealValueSql,
  aliasedEffectiveEstimatingDealValueSql,
  aliasedForecastFirstDealValueSql,
  aliasedOpenPipelineForecastFirstDealValueSql,
  dealAwardedFirstWithFallbackSql,
  dealBestEstimateSql,
  dealBestEstimateWithForecastSql,
  dealEstimatingValueSql,
  effectiveAwardedDealValueSql,
  effectiveDealValueSql,
  effectiveEstimatingDealValueSql,
  effectiveWonDealValueSql,
} from "../../../src/modules/shared/deal-value-sql.js";

function normalize(sqlValue: unknown): string {
  if (typeof sqlValue === "string") return sqlValue;
  if (!sqlValue || typeof sqlValue !== "object") return "";
  if (Array.isArray((sqlValue as { queryChunks?: unknown[] }).queryChunks)) {
    return (sqlValue as { queryChunks: unknown[] }).queryChunks.map(normalize).join("");
  }
  if ("value" in (sqlValue as Record<string, unknown>)) {
    const value = (sqlValue as { value: unknown }).value;
    if (Array.isArray(value)) return value.map(normalize).join("");
    if (typeof value === "string") return value;
  }
  if ("name" in (sqlValue as Record<string, unknown>) && typeof (sqlValue as { name?: unknown }).name === "string") {
    return (sqlValue as { name: string }).name;
  }
  return JSON.stringify(sqlValue);
}

function expectColumnOrder(sqlText: string, columns: readonly string[]) {
  const positions = columns.map((column) => sqlText.indexOf(`d.${column}`));
  for (const [index, position] of positions.entries()) {
    expect(position, `${columns[index]} should be present`).toBeGreaterThanOrEqual(0);
    if (index > 0) {
      expect(position, `${columns[index]} should follow ${columns[index - 1]}`).toBeGreaterThan(
        positions[index - 1]
      );
    }
  }
}

describe("deal-value-sql", () => {
  const table = {
    onHold: sql.raw("d.on_hold"),
    expectedCloseDate: sql.raw("d.expected_close_date"),
    forecastRevenue: sql.raw("d.forecast_revenue"),
    bidBoardTotalSales: sql.raw("d.bid_board_total_sales"),
    bidEstimate: sql.raw("d.bid_estimate"),
    ddEstimate: sql.raw("d.dd_estimate"),
    awardedAmount: sql.raw("d.awarded_amount"),
  };

  it("wraps aliased best-estimate value in an on-hold zeroing case expression", () => {
    expect(normalize(aliasedEffectiveDealValueSql("d"))).toContain("d.on_hold");
    expect(normalize(aliasedEffectiveDealValueSql("d"))).toContain("d.bid_board_total_sales");
    expect(normalize(aliasedEffectiveDealValueSql("d"))).toContain("d.awarded_amount");
    expect(normalize(aliasedEffectiveDealValueSql("d"))).toContain("d.bid_estimate");
    expect(normalize(aliasedEffectiveDealValueSql("d"))).toContain("d.dd_estimate");
  });

  it("OPEN value zeros on EFFECTIVE hold: stored on_hold OR a close target past the 90-day horizon", () => {
    // aliased form reuses the shared filter predicate verbatim, so they can never drift
    const aliased = normalize(aliasedEffectiveDealValueSql("d")).toLowerCase();
    expect(aliased).toContain("coalesce(d.on_hold, false) = true");
    expect(aliased).toContain("d.expected_close_date is not null");
    expect(aliased).toContain("d.expected_close_date > (now() at time zone 'america/chicago')::date + interval '90 days'");
    // column form matches the same boundary
    const column = normalize(effectiveDealValueSql(table)).toLowerCase();
    expect(column).toContain("coalesce(d.on_hold, false) = true");
    expect(column).toContain("d.expected_close_date is not null");
    expect(column).toContain("interval '90 days'");
    expect(column).toContain("america/chicago");
  });

  it("WON/AWARDED value zeros on STORED on_hold ONLY — never the far-future leg (early-won revenue safe)", () => {
    // a deal won EARLY can keep a far-out expected_close_date; the won/awarded helpers must NOT zero it,
    // or realized revenue/commissions silently vanish until the forecast date ages in (the P1).
    for (const won of [normalize(aliasedEffectiveWonDealValueSql("d")).toLowerCase(), normalize(effectiveWonDealValueSql(table)).toLowerCase()]) {
      expect(won).toContain("coalesce(d.on_hold, false)"); // stored-hold zeroing kept
      expect(won).not.toContain("expected_close_date"); // but NO auto-park horizon
      expect(won).not.toContain("interval '90 days'");
    }
  });

  // Convention shift 2026-06-18: the open/best-estimate chain is now AWARDED-FIRST (unified with the won
  // chain) — awarded_amount leads, then bid_board_total_sales > bid_estimate > dd_estimate.
  it("uses the unified awarded-first chain for open/best-estimate raw-value consumers", () => {
    for (const expression of [aliasedDealBestEstimateSql("d"), dealBestEstimateSql(table)]) {
      const normalized = normalize(expression);
      expectColumnOrder(normalized, [
        "awarded_amount",
        "bid_board_total_sales",
        "bid_estimate",
        "dd_estimate",
      ]);
      expect(normalized).toContain("CASE WHEN d.bid_board_total_sales > 0 THEN d.bid_board_total_sales END");
      expect(normalized).toContain("CASE WHEN d.awarded_amount > 0 THEN d.awarded_amount END");
      expect(normalized).not.toContain("NULLIF");
    }
  });

  it("exposes the active-count filter for active-vs-total badge rollups", () => {
    expect(normalize(aliasedActiveDealCountFilterSql("d"))).toContain("d.on_hold");
  });

  it("exposes one reportable-deal SQL predicate for report populations", () => {
    expect(normalize(aliasedReportableDealFilterSql("d"))).toContain(
      "COALESCE(d.on_hold, false) = false"
    );
    expect(normalize(aliasedActiveDealCountFilterSql("d"))).toEqual(
      normalize(aliasedReportableDealFilterSql("d"))
    );
  });

  it("uses the complete forecast-first chain for forecast pipeline consumers", () => {
    for (const expression of [
      aliasedDealBestEstimateWithForecastSql("d"),
      aliasedForecastFirstDealValueSql("d"),
      aliasedOpenPipelineForecastFirstDealValueSql("d"),
      dealBestEstimateWithForecastSql(table),
    ]) {
      const normalized = normalize(expression);
      expectColumnOrder(normalized, [
        "forecast_revenue",
        "awarded_amount",
        "bid_board_total_sales",
        "bid_estimate",
        "dd_estimate",
      ]);
      expect(normalized).toContain("CASE WHEN d.forecast_revenue > 0 THEN d.forecast_revenue END");
      expect(normalized).toContain("CASE WHEN d.bid_board_total_sales > 0 THEN d.bid_board_total_sales END");
      expect(normalized).toContain("CASE WHEN d.awarded_amount > 0 THEN d.awarded_amount END");
      expect(normalized).not.toContain("NULLIF");
    }
  });

  it("keeps the explicit awarded-only helper limited to awarded_amount", () => {
    const normalized = normalize(aliasedDealAwardedAmountSql("d"));
    expect(normalized).toContain("d.awarded_amount");
    expect(normalized).not.toContain("d.bid_board_total_sales");
    expect(normalized).not.toContain("d.bid_estimate");
    expect(normalized).not.toContain("d.dd_estimate");
    expect(normalized).not.toContain("NULLIF");
  });

  it("keeps effective awarded helpers awarded-only to match JS awarded semantics", () => {
    for (const expression of [
      aliasedEffectiveAwardedDealValueSql("d"),
      effectiveAwardedDealValueSql(table),
    ]) {
      const normalized = normalize(expression);
      expect(normalized).toContain("d.on_hold");
      expect(normalized).toContain("d.awarded_amount");
      expect(normalized).not.toContain("d.bid_board_total_sales");
      expect(normalized).not.toContain("d.bid_estimate");
      expect(normalized).not.toContain("d.dd_estimate");
    }
  });

  it("uses the complete awarded-first fallback chain for won value consumers", () => {
    for (const expression of [
      aliasedDealAwardedFirstWithFallbackSql("d"),
      aliasedEffectiveWonDealValueSql("d"),
      dealAwardedFirstWithFallbackSql(table),
      effectiveWonDealValueSql(table),
    ]) {
      const normalized = normalize(expression);
      expectColumnOrder(normalized, [
        "awarded_amount",
        "bid_board_total_sales",
        "bid_estimate",
        "dd_estimate",
      ]);
      expect(normalized).toContain("CASE WHEN d.awarded_amount > 0 THEN d.awarded_amount END");
      expect(normalized).toContain("CASE WHEN d.bid_board_total_sales > 0 THEN d.bid_board_total_sales END");
      expect(normalized).toContain("CASE WHEN d.bid_estimate > 0 THEN d.bid_estimate END");
      expect(normalized).toContain("CASE WHEN d.dd_estimate > 0 THEN d.dd_estimate END");
      expect(normalized).not.toContain("NULLIF");
    }
  });

  // 'estimating' stage rule (2026-06-18): DD outranks bid → awarded > dd > bid_board > bid.
  it("uses the estimating chain (awarded > dd > bid_board > bid) for the estimating value consumers", () => {
    for (const expression of [
      aliasedDealEstimatingValueSql("d"),
      aliasedEffectiveEstimatingDealValueSql("d"),
      dealEstimatingValueSql(table),
      effectiveEstimatingDealValueSql(table),
    ]) {
      const normalized = normalize(expression);
      expectColumnOrder(normalized, [
        "awarded_amount",
        "dd_estimate",
        "bid_board_total_sales",
        "bid_estimate",
      ]);
      expect(normalized).not.toContain("NULLIF");
    }
    // on-hold-zeroed only on the effective variants.
    expect(normalize(aliasedEffectiveEstimatingDealValueSql("d"))).toContain("d.on_hold");
    expect(normalize(effectiveEstimatingDealValueSql(table))).toContain("d.on_hold");
  });

  it("wraps won fallback values in an on-hold zeroing case expression", () => {
    const normalized = normalize(aliasedEffectiveWonDealValueSql("d"));
    expect(normalized).toContain("d.on_hold");
    expect(normalized).toContain("d.awarded_amount");
    expect(normalized).toContain("d.bid_board_total_sales");
    expect(normalized).toContain("d.bid_estimate");
    expect(normalized).toContain("d.dd_estimate");
  });

  it("wraps unaliased open current values in an on-hold zeroing case expression (awarded-first)", () => {
    const normalized = normalize(effectiveDealValueSql(table));
    expect(normalized).toContain("d.on_hold");
    expectColumnOrder(normalized, [
      "awarded_amount",
      "bid_board_total_sales",
      "bid_estimate",
      "dd_estimate",
    ]);
  });

  it("keeps SQL chain order aligned with JS effective value semantics — unified awarded-first for ALL stages", () => {
    // Convention shift 2026-06-18: open/estimating, won, AND lost deals all resolve value AWARDED-FIRST:
    // awarded_amount > bid_board_total_sales > bid_estimate > dd_estimate, each gated > 0 (0 and NULL fall
    // through), on-hold -> 0. Stage classification no longer changes the value chain.

    // Open deal, everything set: awarded wins (was bid_board-first before the shift).
    expect(
      getEffectiveDealValue({
        stageSlug: "opportunity",
        bidBoardTotalSales: "700",
        bidEstimate: "800",
        ddEstimate: "900",
        awardedAmount: "1000",
      })
    ).toBe(1000);

    // Open deal, no awarded, bid_board 0 / bid negative: falls through to dd_estimate (0 and <0 are unset).
    expect(
      getEffectiveDealValue({
        stageSlug: "opportunity",
        bidBoardTotalSales: "0",
        bidEstimate: "-1",
        ddEstimate: "900",
        awardedAmount: null,
      })
    ).toBe(900);

    // Open deal, awarded 0 (unset): skips awarded, bid_board_total_sales wins.
    expect(
      getEffectiveDealValue({
        stageSlug: "opportunity",
        bidBoardTotalSales: "700",
        bidEstimate: "800",
        ddEstimate: "900",
        awardedAmount: "0",
      })
    ).toBe(700);

    // Lost deal, everything set: unified awarded-first -> awarded wins (was bid_board-first before the shift).
    expect(
      getEffectiveDealValue({
        stageSlug: "lost",
        bidBoardStageSlug: "lost",
        awardedAmount: "1000",
        bidBoardTotalSales: "700",
        bidEstimate: "800",
        ddEstimate: "900",
      })
    ).toBe(1000);

    // Lost deal, nothing positive: 0.
    expect(
      getEffectiveDealValue({
        stageSlug: "lost",
        awardedAmount: null,
        bidBoardTotalSales: "0",
        bidEstimate: null,
        ddEstimate: "0",
      })
    ).toBe(0);

    // On-hold -> 0 regardless of values.
    expect(
      getEffectiveDealValue({
        stageSlug: "lost",
        onHold: true,
        awardedAmount: "1000",
        bidBoardTotalSales: "700",
        bidEstimate: "800",
        ddEstimate: "900",
      })
    ).toBe(0);

    // Won deal, awarded 0 (unset): falls through to bid_board_total_sales (unchanged by the shift).
    expect(
      getEffectiveDealValue({
        stageSlug: "won",
        awardedAmount: "0",
        bidBoardTotalSales: "700",
        bidEstimate: "800",
        ddEstimate: "900",
      })
    ).toBe(700);

    // Won deal, awarded set: awarded wins (unchanged by the shift).
    expect(
      getEffectiveDealValue({
        stageSlug: "won",
        awardedAmount: "1000",
        bidBoardTotalSales: "700",
        bidEstimate: "800",
        ddEstimate: "900",
      })
    ).toBe(1000);
  });
});
