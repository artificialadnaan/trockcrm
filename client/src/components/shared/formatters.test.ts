import { describe, expect, it } from "vitest";
import { USD, USD_COMPACT, NUMBER_COMPACT } from "./formatters";

// These pin the behavior the deal-list-page board KPIs depend on, but
// VERSION-AGNOSTICALLY. The board test ("excludes terminal-stage cards from the
// Active Pipeline value and count") was failing because it asserted the literal
// "$180K" while USD_COMPACT(180000) rendered "$180.0K" on the local/CI Node.
//
// The trailing ".0" on ROUND thousands/millions is an ICU/V8-version-dependent
// quirk of compact + style:"currency": Node 20/22 emit "$180.0K"/"$0.0", Node 24+
// emit "$180K"/"$0" (the ".0" was the anomaly; newer ICU drops it). Pinning either
// literal is fragile, so we assert the ".0" as OPTIONAL and pin only the
// invariants: the "$", the compact suffix, and genuine fraction digits (kept by
// every ICU). NUMBER_COMPACT (no currency style) never showed the spurious ".0".
describe("shared formatters — compact Intl output (version-agnostic)", () => {
  it("USD_COMPACT renders compact currency; trailing .0 on round values is optional across Node/ICU", () => {
    expect(USD_COMPACT(180_000)).toMatch(/^\$180(\.0)?K$/);
    expect(USD_COMPACT(125_000)).toMatch(/^\$125(\.0)?K$/);
    expect(USD_COMPACT(4_000_000)).toMatch(/^\$4(\.0)?M$/);
    expect(USD_COMPACT(0)).toMatch(/^\$0(\.0)?$/);
  });

  it("USD_COMPACT keeps a genuine fraction digit (invariant across ICU versions)", () => {
    expect(USD_COMPACT(1_600_000)).toBe("$1.6M");
  });

  it("USD_COMPACT coerces non-finite input to $0 (never renders $NaN on a KPI card)", () => {
    expect(USD_COMPACT(Number.NaN)).toMatch(/^\$0(\.0)?$/);
    expect(USD_COMPACT(Number.POSITIVE_INFINITY)).toMatch(/^\$0(\.0)?$/);
    expect(USD_COMPACT(Number.NEGATIVE_INFINITY)).toMatch(/^\$0(\.0)?$/);
  });

  it("USD (non-compact) renders whole-dollar currency", () => {
    expect(USD(180_000)).toBe("$180,000");
    expect(USD(0)).toBe("$0");
  });

  it("NUMBER_COMPACT renders compact counts (no currency style, no spurious .0)", () => {
    expect(NUMBER_COMPACT(180_000)).toMatch(/^180(\.0)?K$/);
    expect(NUMBER_COMPACT(1_600_000)).toBe("1.6M");
  });
});
