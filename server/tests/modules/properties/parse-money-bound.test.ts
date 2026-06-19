import { describe, expect, it } from "vitest";
import { parseMoneyBound } from "../../../src/modules/properties/query-params.js";

/**
 * Regression guard for the Linked Value min/max filter (PR #779, CodeRabbit Major): Express query-param
 * values are `string | string[] | undefined`, so a repeated `?minLinkedValue=...` arrives as an ARRAY.
 * The old inline parser called `raw.trim()` on it and threw -> 500. parseMoneyBound must treat any
 * non-string / blank / non-finite value as "no bound" (undefined) and never throw.
 */
describe("parseMoneyBound", () => {
  it("parses a numeric string", () => {
    expect(parseMoneyBound("100")).toBe(100);
    expect(parseMoneyBound("1500000.50")).toBe(1500000.5);
  });

  it("honours a 0 lower bound (>= 0, not falsy-dropped)", () => {
    expect(parseMoneyBound("0")).toBe(0);
  });

  it("treats blank / whitespace as no bound", () => {
    expect(parseMoneyBound("")).toBeUndefined();
    expect(parseMoneyBound("   ")).toBeUndefined();
  });

  it("treats absent (undefined) as no bound", () => {
    expect(parseMoneyBound(undefined)).toBeUndefined();
  });

  it("ignores non-numeric / non-finite strings (no NaN poisoning the query)", () => {
    expect(parseMoneyBound("abc")).toBeUndefined();
    expect(parseMoneyBound("NaN")).toBeUndefined();
    expect(parseMoneyBound("Infinity")).toBeUndefined();
  });

  it("does NOT throw on a repeated (array) query param — returns undefined instead of a 500", () => {
    expect(() => parseMoneyBound(["1", "2"] as unknown)).not.toThrow();
    expect(parseMoneyBound(["1", "2"] as unknown)).toBeUndefined();
  });

  it("safely ignores object / other non-string query shapes", () => {
    expect(parseMoneyBound({} as unknown)).toBeUndefined();
    expect(parseMoneyBound(123 as unknown)).toBeUndefined();
    expect(parseMoneyBound(null as unknown)).toBeUndefined();
  });
});
