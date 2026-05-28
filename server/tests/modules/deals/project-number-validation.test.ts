import { describe, expect, it } from "vitest";
import {
  CANONICAL_PROJECT_NUMBER_REGEX_STRICT,
  ProjectNumberValidationError,
  isAcceptedProjectNumber,
  isStrictCanonicalProjectNumber,
  normalizeProjectNumberInput,
} from "../../../src/modules/deals/project-number-validation.js";

describe("CANONICAL_PROJECT_NUMBER_REGEX_STRICT", () => {
  it("accepts single-digit non-zero project-type codes with one or more lowercase suffix letters", () => {
    expect(CANONICAL_PROJECT_NUMBER_REGEX_STRICT.test("DFW-1-12345-a")).toBe(true);
    expect(CANONICAL_PROJECT_NUMBER_REGEX_STRICT.test("DFW-1-12345-aa")).toBe(true);
    expect(CANONICAL_PROJECT_NUMBER_REGEX_STRICT.test("DFW-1-12345-aaa")).toBe(true);
    expect(CANONICAL_PROJECT_NUMBER_REGEX_STRICT.test("ATL-9-54321-z")).toBe(true);
  });

  it("rejects zero or multi-digit project-type codes", () => {
    expect(CANONICAL_PROJECT_NUMBER_REGEX_STRICT.test("DFW-0-12345-a")).toBe(false);
    expect(CANONICAL_PROJECT_NUMBER_REGEX_STRICT.test("DFW-12-12345-a")).toBe(false);
    expect(CANONICAL_PROJECT_NUMBER_REGEX_STRICT.test("DFW-a-12345-a")).toBe(false);
  });

  it("rejects non-five-digit numeric components", () => {
    expect(CANONICAL_PROJECT_NUMBER_REGEX_STRICT.test("DFW-1-1234-a")).toBe(false);
    expect(CANONICAL_PROJECT_NUMBER_REGEX_STRICT.test("DFW-1-123456-a")).toBe(false);
  });

  it("rejects uppercase letters or empty suffixes", () => {
    expect(CANONICAL_PROJECT_NUMBER_REGEX_STRICT.test("DFW-1-12345-A")).toBe(false);
    expect(CANONICAL_PROJECT_NUMBER_REGEX_STRICT.test("DFW-1-12345-")).toBe(false);
  });

  it("rejects non-DFW/ATL office prefixes and non-uppercase forms", () => {
    expect(CANONICAL_PROJECT_NUMBER_REGEX_STRICT.test("HOU-1-12345-a")).toBe(false);
    expect(CANONICAL_PROJECT_NUMBER_REGEX_STRICT.test("dfw-1-12345-a")).toBe(false);
  });
});

describe("isAcceptedProjectNumber (legacy + canonical formats)", () => {
  it("accepts the strict canonical form", () => {
    expect(isAcceptedProjectNumber("DFW-1-12345-a")).toBe(true);
    expect(isAcceptedProjectNumber("ATL-2-54321-ab")).toBe(true);
  });

  it("accepts the legacy lenient canonical form (multi-digit/letter type code)", () => {
    // Legacy lenient canonical with single-letter type code (operator-confirmed example).
    expect(isAcceptedProjectNumber("DFW-a-05826-ad")).toBe(true);
    // Legacy lenient canonical with multi-digit type code.
    expect(isAcceptedProjectNumber("DFW-10-12345-aa")).toBe(true);
  });

  it("accepts custom rep-prefix alphanumeric codes", () => {
    // Operator-confirmed legacy codes.
    for (const value of [
      "KMPWINTERS",
      "KMTIDESNDDEMO",
      "KMRPMLVRRR",
      "KMTIDESNDTEMP",
      "KMMBUNITBB",
      "KMRPMLVIN",
      "ASRPMLVIUN",
      "KMRPMTND",
    ]) {
      expect(isAcceptedProjectNumber(value), `expected ${value} to be accepted`).toBe(true);
    }
  });

  it("accepts legacy import date-suffix formats", () => {
    // Operator-confirmed legacy import codes.
    for (const value of [
      "1-TLV.1-091625",
      "1-TND.1-081425",
      "1-THR.1-FCP-092425",
      "2-TAT3-111325",
      "2-MPA1-100225",
      "2-CSP.1-101325",
    ]) {
      expect(isAcceptedProjectNumber(value), `expected ${value} to be accepted`).toBe(true);
    }
  });

  it("rejects obviously-invalid values", () => {
    expect(isAcceptedProjectNumber("")).toBe(false);
    expect(isAcceptedProjectNumber("   ")).toBe(false);
    // Short-numeric legacy that the prior test corpus expected to be rejected.
    expect(isAcceptedProjectNumber("DFW-1-1234-aa")).toBe(false);
    // Lowercase canonical prefix is not accepted (we expect upstream callers to
    // run the case-normalization migration if they have lowercase prefixes).
    expect(isAcceptedProjectNumber("dfw-1-12345-aa")).toBe(false);
    // SQL-injection-shaped payload.
    expect(isAcceptedProjectNumber("'; DROP TABLE deals; --")).toBe(false);
    // Contains a space.
    expect(isAcceptedProjectNumber("DFW 1 12345 a")).toBe(false);
  });

  it("rejects a zero leading project-type code in the legacy date-suffix form", () => {
    // The [1-9] convention from the strict canonical form is mirrored here:
    // a 0 project-type code is invalid everywhere.
    expect(isAcceptedProjectNumber("0-TLV.1-091625")).toBe(false);
    // Sanity: the non-zero variant is still accepted.
    expect(isAcceptedProjectNumber("1-TLV.1-091625")).toBe(true);
  });

  it("rejects short uppercase tokens that look like accidental operator typos", () => {
    // Words an operator might accidentally type into the field. The rep-prefix
    // accept regex is intentionally narrower than `[A-Z0-9]{4,20}` to filter these out.
    expect(isAcceptedProjectNumber("TODO")).toBe(false);
    expect(isAcceptedProjectNumber("TBD")).toBe(false);
    expect(isAcceptedProjectNumber("TBD123")).toBe(false);
    expect(isAcceptedProjectNumber("ABCD1")).toBe(false);
    // Purely numeric tokens are not custom-prefix codes.
    expect(isAcceptedProjectNumber("12345678")).toBe(false);
  });
});

describe("isStrictCanonicalProjectNumber", () => {
  it("matches the strict regex", () => {
    expect(isStrictCanonicalProjectNumber("DFW-1-12345-a")).toBe(true);
    expect(isStrictCanonicalProjectNumber("DFW-a-12345-aa")).toBe(false);
    expect(isStrictCanonicalProjectNumber("KMPWINTERS")).toBe(false);
  });
});

describe("normalizeProjectNumberInput", () => {
  it("returns null for nullish input", () => {
    expect(normalizeProjectNumberInput(null)).toBeNull();
    expect(normalizeProjectNumberInput(undefined)).toBeNull();
  });

  it("trims and accepts the strict canonical form", () => {
    expect(normalizeProjectNumberInput("  DFW-1-12345-aa  ")).toBe("DFW-1-12345-aa");
  });

  it("accepts operator-confirmed legacy formats unchanged", () => {
    expect(normalizeProjectNumberInput("KMPWINTERS")).toBe("KMPWINTERS");
    expect(normalizeProjectNumberInput("1-TLV.1-091625")).toBe("1-TLV.1-091625");
    expect(normalizeProjectNumberInput("DFW-a-05826-ad")).toBe("DFW-a-05826-ad");
  });

  it("throws ProjectNumberValidationError on blank input", () => {
    expect(() => normalizeProjectNumberInput("")).toThrow(ProjectNumberValidationError);
    expect(() => normalizeProjectNumberInput("   ")).toThrow(ProjectNumberValidationError);
  });

  it("throws ProjectNumberValidationError on non-string input", () => {
    expect(() => normalizeProjectNumberInput(42 as unknown)).toThrow(ProjectNumberValidationError);
  });

  it("throws ProjectNumberValidationError on oversized input", () => {
    const oversized = `DFW-1-12345-${"a".repeat(120)}`;
    expect(() => normalizeProjectNumberInput(oversized)).toThrow(ProjectNumberValidationError);
  });

  it("throws ProjectNumberValidationError on unrecognized format", () => {
    expect(() => normalizeProjectNumberInput("DFW-1-1234-aa")).toThrow(ProjectNumberValidationError);
    expect(() => normalizeProjectNumberInput("dfw-1-12345-aa")).toThrow(ProjectNumberValidationError);
  });
});
