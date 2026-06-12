import { describe, expect, it } from "vitest";
import { resolveRegionPeriod, REGION_PERIOD_OPTIONS, pctLabel, heatIntensity } from "./region-report";

const NOW = new Date("2026-03-18T18:00:00Z"); // matches the canonical resolveDatePreset boundary cases

describe("resolveRegionPeriod (F1-aligned period toggle)", () => {
  it("maps the four toggle keys to {from,to} business-tz ranges", () => {
    expect(resolveRegionPeriod("wtd", NOW)).toEqual({ from: "2026-03-15", to: "2026-03-18" });
    expect(resolveRegionPeriod("mtd", NOW)).toEqual({ from: "2026-03-01", to: "2026-03-18" });
    expect(resolveRegionPeriod("ytd", NOW)).toEqual({ from: "2026-01-01", to: "2026-03-18" });
    // "This year" = full calendar year (won data has no future, so it matches YTD's data with a Dec-31 bound)
    expect(resolveRegionPeriod("year", NOW)).toEqual({ from: "2026-01-01", to: "2026-12-31" });
  });

  it("exposes exactly the four labelled options in order", () => {
    expect(REGION_PERIOD_OPTIONS.map((o) => o.value)).toEqual(["wtd", "mtd", "year", "ytd"]);
    expect(REGION_PERIOD_OPTIONS.map((o) => o.label)).toEqual(["This Week", "This Month", "This Year", "YTD"]);
  });
});

describe("pctLabel (safe percent — never NaN/0% for unknown)", () => {
  it("renders the value with a % suffix, em dash for null", () => {
    expect(pctLabel(50)).toBe("50%");
    expect(pctLabel(33.3)).toBe("33.3%");
    expect(pctLabel(0)).toBe("0%"); // a real 0% is a value
    expect(pctLabel(null)).toBe("—"); // unknown (no won+lost) is NOT 0%
  });
});

describe("heatIntensity (region×stage heatmap colour scale)", () => {
  it("is value/max clamped to [0,1], and 0 when max is 0 (no div-by-zero)", () => {
    expect(heatIntensity(0, 100)).toBe(0);
    expect(heatIntensity(50, 100)).toBe(0.5);
    expect(heatIntensity(100, 100)).toBe(1);
    expect(heatIntensity(50, 0)).toBe(0);
    expect(heatIntensity(0, 0)).toBe(0);
  });
});
