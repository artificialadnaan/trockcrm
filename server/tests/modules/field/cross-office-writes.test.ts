import { afterEach, describe, expect, it } from "vitest";
import {
  isFieldCrossOfficeWritesEnabled,
  pickWriteOfficeSource,
  requireResolvedOffice,
  type FieldOffice,
} from "../../../src/modules/field/cross-office.js";

const ENV_KEY = "FIELD_CROSS_OFFICE_WRITES_ENABLED";

describe("isFieldCrossOfficeWritesEnabled", () => {
  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it("is false when unset (default OFF — merging the PR does not activate writes)", () => {
    delete process.env[ENV_KEY];
    expect(isFieldCrossOfficeWritesEnabled()).toBe(false);
  });

  it('is true ONLY for the exact string "true"', () => {
    process.env[ENV_KEY] = "true";
    expect(isFieldCrossOfficeWritesEnabled()).toBe(true);
  });

  it("is false for any other truthy-looking value", () => {
    for (const value of ["1", "yes", "TRUE", "on", ""]) {
      process.env[ENV_KEY] = value;
      expect(isFieldCrossOfficeWritesEnabled()).toBe(false);
    }
  });
});

describe("pickWriteOfficeSource", () => {
  it("uses the UPLOADER's office when the flag is OFF, even with a target (today's behavior)", () => {
    expect(pickWriteOfficeSource(false, { dealId: "d1" })).toBe("uploader");
    expect(pickWriteOfficeSource(false, { leadId: "l1" })).toBe("uploader");
  });

  it("uses the UPLOADER's office when the flag is ON but there is no target (unassigned upload)", () => {
    expect(pickWriteOfficeSource(true, {})).toBe("uploader");
  });

  it("resolves the DEAL's office when the flag is ON and a dealId is present", () => {
    expect(pickWriteOfficeSource(true, { dealId: "d1" })).toEqual({ kind: "deal", id: "d1" });
  });

  it("resolves an opportunityId as a DEAL (opportunities are deal records)", () => {
    expect(pickWriteOfficeSource(true, { opportunityId: "o1" })).toEqual({ kind: "deal", id: "o1" });
  });

  it("resolves the LEAD's office when the flag is ON and a leadId is present", () => {
    expect(pickWriteOfficeSource(true, { leadId: "l1" })).toEqual({ kind: "lead", id: "l1" });
  });

  it("prefers an explicit dealId over opportunityId when both are (defensively) present", () => {
    expect(pickWriteOfficeSource(true, { dealId: "d1", opportunityId: "o1" })).toEqual({ kind: "deal", id: "d1" });
  });
});

describe("requireResolvedOffice", () => {
  const office: FieldOffice = { id: "id-atlanta", slug: "atlanta" };

  it("returns the office when resolution found an owner", () => {
    expect(requireResolvedOffice(office, "Capture target not found")).toBe(office);
  });

  it("throws 404 (write nothing) when no active office owns the id", () => {
    expect(() => requireResolvedOffice(null, "Capture target not found")).toThrowError(/Capture target not found/);
    try {
      requireResolvedOffice(null, "Capture target not found");
    } catch (err: any) {
      expect(err.statusCode).toBe(404);
    }
  });
});
