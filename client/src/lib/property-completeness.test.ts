import { describe, expect, it } from "vitest";
import {
  getMissingPropertyFields,
  isPositiveInteger,
  isValidBuildYear,
  maxPropertyBuildYear,
} from "./property-completeness";

describe("isValidBuildYear", () => {
  const maxYear = maxPropertyBuildYear();

  it("accepts the lower boundary 1800", () => {
    expect(isValidBuildYear(1800)).toBe(true);
  });

  it("accepts the dynamic max year boundary", () => {
    expect(isValidBuildYear(maxYear)).toBe(true);
  });

  it("rejects below the lower boundary", () => {
    expect(isValidBuildYear(1799)).toBe(false);
  });

  it("rejects above the max year", () => {
    expect(isValidBuildYear(maxYear + 1)).toBe(false);
  });

  it("rejects non-integer numbers", () => {
    expect(isValidBuildYear(1990.5)).toBe(false);
  });

  it("rejects non-number values", () => {
    expect(isValidBuildYear("1990")).toBe(false);
    expect(isValidBuildYear(null)).toBe(false);
    expect(isValidBuildYear(undefined)).toBe(false);
  });

  it("honors an explicit maxYear argument", () => {
    expect(isValidBuildYear(2050, 2049)).toBe(false);
    expect(isValidBuildYear(2049, 2049)).toBe(true);
  });
});

describe("isPositiveInteger", () => {
  it("rejects zero", () => {
    expect(isPositiveInteger(0)).toBe(false);
  });

  it("rejects negatives", () => {
    expect(isPositiveInteger(-5)).toBe(false);
  });

  it("rejects non-integers", () => {
    expect(isPositiveInteger(2.5)).toBe(false);
  });

  it("rejects non-number values", () => {
    expect(isPositiveInteger("3")).toBe(false);
    expect(isPositiveInteger(null)).toBe(false);
    expect(isPositiveInteger(undefined)).toBe(false);
  });

  it("accepts positive integers", () => {
    expect(isPositiveInteger(1)).toBe(true);
    expect(isPositiveInteger(120)).toBe(true);
  });
});

describe("getMissingPropertyFields", () => {
  const completeAddress = {
    address: "123 Main St",
    city: "Dallas",
    state: "TX",
    zip: "75201",
    buildYear: null,
    unitCount: null,
  };

  it("returns no missing address fields for a valid address when requireLeadCreate is false", () => {
    expect(getMissingPropertyFields(completeAddress, { requireLeadCreate: false })).toEqual([]);
  });

  it("requires buildYear and unitCount only when requireLeadCreate is true", () => {
    expect(getMissingPropertyFields(completeAddress, { requireLeadCreate: true })).toEqual([
      "buildYear",
      "unitCount",
    ]);
  });

  it("flags every missing address field", () => {
    expect(
      getMissingPropertyFields(
        { address: null, city: "", state: "T", zip: "123" },
        { requireLeadCreate: false }
      )
    ).toEqual(["address", "city", "state", "zip"]);
  });

  it("accepts ZIP+4 and uppercases state for validation", () => {
    expect(
      getMissingPropertyFields(
        { address: "1 A St", city: "Atlanta", state: "ga", zip: "30301-1234", buildYear: 2000, unitCount: 12 },
        { requireLeadCreate: true }
      )
    ).toEqual([]);
  });

  it("returns only the invalid lead-create numeric fields", () => {
    expect(
      getMissingPropertyFields(
        { ...completeAddress, buildYear: 1999, unitCount: 0 },
        { requireLeadCreate: true }
      )
    ).toEqual(["unitCount"]);
  });
});
