import { describe, expect, it } from "vitest";
import {
  aliasedActiveDealCountFilterSql,
  aliasedReportableDealFilterSql,
  aliasedEffectiveAwardedDealValueSql,
  aliasedDealBestEstimateSql,
  aliasedDealBestEstimateWithForecastSql,
  aliasedEffectiveDealValueSql,
} from "./deal-value-sql.js";

function normalize(sqlValue: unknown) {
  return JSON.stringify(sqlValue);
}

describe("deal-value-sql", () => {
  it("wraps aliased best-estimate value in an on-hold zeroing case expression", () => {
    expect(normalize(aliasedEffectiveDealValueSql("d"))).toContain("d.on_hold");
    expect(normalize(aliasedEffectiveDealValueSql("d"))).toContain("d.awarded_amount");
    expect(normalize(aliasedEffectiveDealValueSql("d"))).toContain("d.bid_estimate");
    expect(normalize(aliasedEffectiveDealValueSql("d"))).toContain("d.dd_estimate");
  });

  it("supports forecast-aware raw values for company-style rollups", () => {
    expect(normalize(aliasedDealBestEstimateWithForecastSql("d"))).toContain("d.forecast_revenue");
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

  it("builds the base best-estimate expression once for raw-value consumers", () => {
    expect(normalize(aliasedDealBestEstimateSql("d"))).toContain("d.awarded_amount");
  });

  it("exposes an awarded-only on-hold-aware expression for won/booked rollups", () => {
    const normalized = normalize(aliasedEffectiveAwardedDealValueSql("d"));
    expect(normalized).toContain("d.on_hold");
    expect(normalized).toContain("d.awarded_amount");
    expect(normalized).not.toContain("d.bid_estimate");
    expect(normalized).not.toContain("d.dd_estimate");
  });
});
