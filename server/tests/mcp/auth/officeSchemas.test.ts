import { describe, it, expect } from "vitest";
import {
  KNOWN_OFFICE_SCHEMAS,
  isKnownOfficeSchema,
} from "../../../src/mcp/auth/officeSchemas.js";

describe("MCP office schema allowlist", () => {
  it("contains exactly the three known tenant schemas", () => {
    expect([...KNOWN_OFFICE_SCHEMAS].sort()).toEqual(
      ["office_atlanta", "office_dallas", "office_pwauditoffice"].sort()
    );
  });

  it("accepts each known office schema", () => {
    for (const schema of KNOWN_OFFICE_SCHEMAS) {
      expect(isKnownOfficeSchema(schema)).toBe(true);
    }
  });

  it("rejects an unknown office schema", () => {
    expect(isKnownOfficeSchema("office_houston")).toBe(false);
  });

  it("rejects a SQL-injection style value (never interpolated, only allowlisted)", () => {
    expect(isKnownOfficeSchema("office_dallas; DROP SCHEMA public")).toBe(false);
    expect(isKnownOfficeSchema("office_dallas,public")).toBe(false);
  });

  it("rejects the public schema and empty/whitespace strings", () => {
    expect(isKnownOfficeSchema("public")).toBe(false);
    expect(isKnownOfficeSchema("")).toBe(false);
    expect(isKnownOfficeSchema("  ")).toBe(false);
  });

  it("is case-sensitive — uppercase variants are rejected", () => {
    expect(isKnownOfficeSchema("OFFICE_DALLAS")).toBe(false);
    expect(isKnownOfficeSchema("Office_Dallas")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isKnownOfficeSchema(undefined)).toBe(false);
    expect(isKnownOfficeSchema(null)).toBe(false);
    expect(isKnownOfficeSchema(123)).toBe(false);
    expect(isKnownOfficeSchema({ office: "office_dallas" })).toBe(false);
  });
});
