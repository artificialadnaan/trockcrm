import { describe, expect, it } from "vitest";
import { formatCurrency, formatCompact, formatPercent } from "./chart-colors";

// This formatter is the compact one used by charts AND by deal/dashboard surfaces
// (rep cards, stale-deal list, funnel buckets, director workspace, report cells).
// It previously rendered the literal "$NaN" for NaN input and threw for
// null/undefined (`.toFixed` on a non-number). These tests are the regression
// guard: missing/invalid input must degrade to the safe "--" while every
// valid-number output stays byte-for-byte unchanged.
describe("chart-colors formatCurrency (hardened)", () => {
  it("returns the safe fallback — never '$NaN', never throws — for missing/non-finite input", () => {
    expect(formatCurrency(null)).toBe("--");
    expect(formatCurrency(undefined)).toBe("--");
    expect(formatCurrency(NaN)).toBe("--");
    expect(formatCurrency(Infinity)).toBe("--");
    expect(formatCurrency(-Infinity)).toBe("--");
    // The exact bug being killed, asserted explicitly:
    expect(formatCurrency(NaN)).not.toBe("$NaN");
  });

  it("renders a real zero as '$0' (only missing/invalid → '--')", () => {
    expect(formatCurrency(0)).toBe("$0");
  });

  it("leaves valid-number formatting unchanged (compact $K/$M — no behavior change)", () => {
    expect(formatCurrency(999)).toBe("$999");
    expect(formatCurrency(1_000)).toBe("$1K");
    expect(formatCurrency(12_000)).toBe("$12K");
    expect(formatCurrency(999_999)).toBe("$1000K");
    expect(formatCurrency(1_500_000)).toBe("$1.5M");
    expect(formatCurrency(2_000_000)).toBe("$2.0M");
    // Negatives are valid numbers — they fall through to the base branch unchanged.
    expect(formatCurrency(-500)).toBe("$-500");
  });
});

// formatCompact (compact COUNT — "1.2K", "5M") previously emitted the literal
// "NaN" / "NaN.0K" for bad input and "null"/"undefined" via String(value).
// Same finite-guard as formatCurrency: missing/invalid → "--", a real 0 → "0".
describe("chart-colors formatCompact (hardened)", () => {
  it("returns the safe fallback — never 'NaN', never 'null'/'undefined' — for missing/non-finite input", () => {
    expect(formatCompact(null)).toBe("--");
    expect(formatCompact(undefined)).toBe("--");
    expect(formatCompact(NaN)).toBe("--");
    expect(formatCompact(Infinity)).toBe("--");
    expect(formatCompact(-Infinity)).toBe("--");
    expect(formatCompact(NaN)).not.toContain("NaN");
  });

  it("renders a real zero as '0' (only missing/invalid → '--')", () => {
    expect(formatCompact(0)).toBe("0");
  });

  it("leaves valid-number formatting unchanged — no behavior change", () => {
    expect(formatCompact(50)).toBe("50");
    expect(formatCompact(999)).toBe("999");
    expect(formatCompact(1_200)).toBe("1.2K");
    expect(formatCompact(5_000_000)).toBe("5.0M");
    expect(formatCompact(-3)).toBe("-3");
  });
});

// formatPercent ("42%") previously coerced bad input into "NaN%" / "null%" /
// "undefined%" / "Infinity%" via the template literal. Same guard: missing/invalid
// → "--" (matching how the director dashboard already renders a null win rate),
// a real 0 → "0%". It is also a Recharts tick/tooltip formatter — display only.
describe("chart-colors formatPercent (hardened)", () => {
  it("returns the safe fallback — never 'NaN%'/'null%'/'undefined%' — for missing/non-finite input", () => {
    expect(formatPercent(null)).toBe("--");
    expect(formatPercent(undefined)).toBe("--");
    expect(formatPercent(NaN)).toBe("--");
    expect(formatPercent(Infinity)).toBe("--");
    expect(formatPercent(-Infinity)).toBe("--");
    expect(formatPercent(NaN)).not.toContain("NaN");
  });

  it("renders a real zero as '0%' (only missing/invalid → '--')", () => {
    expect(formatPercent(0)).toBe("0%");
  });

  it("leaves valid-number formatting unchanged — no behavior change", () => {
    expect(formatPercent(42)).toBe("42%");
    expect(formatPercent(100)).toBe("100%");
    expect(formatPercent(7.5)).toBe("7.5%");
  });
});
