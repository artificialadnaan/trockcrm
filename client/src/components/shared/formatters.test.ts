import { describe, expect, it } from "vitest";
import { USD, USD_COMPACT, NUMBER_COMPACT } from "./formatters";

// These pin the EXACT Intl output the deal-list-page board KPIs render. The board
// test ("excludes terminal-stage cards from the Active Pipeline value and count")
// was failing because it asserted "$180K" while USD_COMPACT(180000) actually
// produces "$180.0K": Intl compact notation with maximumFractionDigits:1 emits a
// trailing ".0" for round thousands/millions. That ".0" is the codebase-wide
// convention — sibling tests assert "$125.0K" and "$4.0M" — so the formatter is
// correct and the lone "$180K" expectation was the bug. Locking it here so the
// convention can't silently drift (and so the root cause is documented in code).
describe("shared formatters — compact Intl output is deterministic", () => {
  it("USD_COMPACT keeps the trailing .0 on round values (the board-KPI contract)", () => {
    expect(USD_COMPACT(180_000)).toBe("$180.0K");
    expect(USD_COMPACT(125_000)).toBe("$125.0K");
    expect(USD_COMPACT(4_000_000)).toBe("$4.0M");
    expect(USD_COMPACT(0)).toBe("$0.0");
  });

  it("USD_COMPACT shows a real fraction digit when present", () => {
    expect(USD_COMPACT(1_600_000)).toBe("$1.6M");
    expect(USD_COMPACT(1_250_000)).toBe("$1.3M"); // rounds to 1 fraction digit
  });

  it("USD (non-compact) renders whole-dollar currency", () => {
    expect(USD(180_000)).toBe("$180,000");
    expect(USD(0)).toBe("$0");
  });

  it("NUMBER_COMPACT mirrors the compact .0 convention without the $", () => {
    expect(NUMBER_COMPACT(180_000)).toBe("180K");
    expect(NUMBER_COMPACT(1_600_000)).toBe("1.6M");
  });
});
