import { describe, expect, it } from "vitest";
import { formatCurrency } from "./chart-colors";

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
