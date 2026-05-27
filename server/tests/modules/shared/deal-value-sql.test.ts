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
  aliasedEffectiveDealValueSql,
  aliasedForecastFirstDealValueSql,
  aliasedOpenPipelineForecastFirstDealValueSql,
  dealAwardedFirstWithFallbackSql,
  dealBestEstimateSql,
  dealBestEstimateWithForecastSql,
  effectiveAwardedDealValueSql,
  effectiveDealValueSql,
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

  it("uses the complete open current-value chain for raw-value consumers", () => {
    for (const expression of [aliasedDealBestEstimateSql("d"), dealBestEstimateSql(table)]) {
      const normalized = normalize(expression);
      expectColumnOrder(normalized, [
        "bid_board_total_sales",
        "bid_estimate",
        "dd_estimate",
        "awarded_amount",
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
        "bid_board_total_sales",
        "bid_estimate",
        "dd_estimate",
        "awarded_amount",
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

  it("wraps won fallback values in an on-hold zeroing case expression", () => {
    const normalized = normalize(aliasedEffectiveWonDealValueSql("d"));
    expect(normalized).toContain("d.on_hold");
    expect(normalized).toContain("d.awarded_amount");
    expect(normalized).toContain("d.bid_board_total_sales");
    expect(normalized).toContain("d.bid_estimate");
    expect(normalized).toContain("d.dd_estimate");
  });

  it("wraps unaliased open current values in an on-hold zeroing case expression", () => {
    const normalized = normalize(effectiveDealValueSql(table));
    expect(normalized).toContain("d.on_hold");
    expectColumnOrder(normalized, [
      "bid_board_total_sales",
      "bid_estimate",
      "dd_estimate",
      "awarded_amount",
    ]);
  });

  it("keeps SQL chain order aligned with JS effective value semantics for open and won deals", () => {
    expect(
      getEffectiveDealValue({
        stageSlug: "opportunity",
        bidBoardTotalSales: "700",
        bidEstimate: "800",
        ddEstimate: "900",
        awardedAmount: "1000",
      })
    ).toBe(700);

    expect(
      getEffectiveDealValue({
        stageSlug: "opportunity",
        bidBoardTotalSales: "0",
        bidEstimate: "-1",
        ddEstimate: "900",
        awardedAmount: "1000",
      })
    ).toBe(900);

    expect(
      getEffectiveDealValue({
        stageSlug: "lost",
        bidBoardStageSlug: "lost",
        awardedAmount: "1000",
        bidBoardTotalSales: "700",
        bidEstimate: "800",
        ddEstimate: "900",
      })
    ).toBe(700);

    expect(
      getEffectiveDealValue({
        stageSlug: "lost",
        awardedAmount: "1000",
        bidBoardTotalSales: "0",
        bidEstimate: null,
        ddEstimate: "0",
      })
    ).toBe(1000);

    expect(
      getEffectiveDealValue({
        stageSlug: "lost",
        awardedAmount: null,
        bidBoardTotalSales: "0",
        bidEstimate: null,
        ddEstimate: "0",
      })
    ).toBe(0);

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

    expect(
      getEffectiveDealValue({
        stageSlug: "won",
        awardedAmount: "0",
        bidBoardTotalSales: "700",
        bidEstimate: "800",
        ddEstimate: "900",
      })
    ).toBe(700);

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
