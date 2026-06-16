import { describe, it, expect } from "vitest";
import { compareText, compareNumber, compareDate } from "./comparators";

// Real report values: Platform Usage action counts and Director Scorecard dates.
describe("compareNumber", () => {
  it("sorts numerically, never lexically (9 < 10 < 100)", () => {
    const sortedAsc = [100, 9, 10].sort((a, b) => compareNumber(a, b, "asc"));
    expect(sortedAsc).toEqual([9, 10, 100]); // lexical would give [10, 100, 9]
    const sortedDesc = [9, 100, 10].sort((a, b) => compareNumber(a, b, "desc"));
    expect(sortedDesc).toEqual([100, 10, 9]);
  });

  it("puts nullish last in BOTH directions", () => {
    expect([5, null, 1].sort((a, b) => compareNumber(a, b, "asc"))).toEqual([1, 5, null]);
    expect([5, null, 1].sort((a, b) => compareNumber(a, b, "desc"))).toEqual([5, 1, null]);
    expect([undefined, 2].sort((a, b) => compareNumber(a, b, "asc"))).toEqual([2, undefined]);
  });
});

describe("compareText", () => {
  it("sorts alphabetically, case-insensitive", () => {
    expect(["beta", "Alpha", "gamma"].sort((a, b) => compareText(a, b, "asc"))).toEqual([
      "Alpha",
      "beta",
      "gamma",
    ]);
  });

  it("treats empty string / nullish as last in both directions", () => {
    expect(["b", "", "a"].sort((a, b) => compareText(a, b, "asc"))).toEqual(["a", "b", ""]);
    expect(["b", "", "a"].sort((a, b) => compareText(a, b, "desc"))).toEqual(["b", "a", ""]);
  });
});

describe("compareDate", () => {
  it("sorts chronologically, not by string surface form", () => {
    const dates = ["2026-01-09", "2026-01-10", "2025-12-31"];
    expect(dates.slice().sort((a, b) => compareDate(a, b, "asc"))).toEqual([
      "2025-12-31",
      "2026-01-09",
      "2026-01-10",
    ]);
    expect(dates.slice().sort((a, b) => compareDate(a, b, "desc"))).toEqual([
      "2026-01-10",
      "2026-01-09",
      "2025-12-31",
    ]);
  });

  it("puts null dates last in both directions", () => {
    expect(["2026-01-01", null].sort((a, b) => compareDate(a, b, "asc"))).toEqual(["2026-01-01", null]);
    expect(["2026-01-01", null].sort((a, b) => compareDate(a, b, "desc"))).toEqual(["2026-01-01", null]);
  });

  it("puts unparseable date strings last in both directions", () => {
    expect(["2026-01-01", "not-a-date"].sort((a, b) => compareDate(a, b, "asc"))).toEqual([
      "2026-01-01",
      "not-a-date",
    ]);
    expect(["2026-01-01", "not-a-date"].sort((a, b) => compareDate(a, b, "desc"))).toEqual([
      "2026-01-01",
      "not-a-date",
    ]);
  });
});
