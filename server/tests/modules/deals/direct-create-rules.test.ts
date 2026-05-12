import { describe, expect, it } from "vitest";
import {
  canCreateDealWithoutSourceLead,
  resolveDealCreationPolicy,
} from "../../../src/modules/deals/direct-create-rules.js";

describe("direct deal create rules", () => {
  it("allows direct deal creation when company and property are provided", () => {
    expect(
      canCreateDealWithoutSourceLead({
        companyId: "company-1",
        propertyId: "property-1",
      })
    ).toBe(true);
  });

  it("blocks direct deal creation when property lineage is incomplete", () => {
    expect(
      canCreateDealWithoutSourceLead({
        companyId: "company-1",
        propertyId: null,
      })
    ).toBe(false);
  });

  it("allows direct deal creation without a source lead when company and property are supplied", () => {
    expect(
      resolveDealCreationPolicy({
        creationContext: "direct",
        companyId: "company-1",
        propertyId: "property-1",
        sourceLeadId: null,
      })
    ).toEqual({ allowed: true, origin: "direct" });
  });

  it("requires a source lead for lead conversion context", () => {
    expect(
      resolveDealCreationPolicy({
        creationContext: "lead_conversion",
        sourceLeadWriteMode: "lead_conversion",
        companyId: "company-1",
        propertyId: "property-1",
        sourceLeadId: null,
      })
    ).toEqual({
      allowed: false,
      origin: "lead_conversion",
      reason: "sourceLeadId is required for lead conversion deal creation",
    });
  });

  it("does not infer lead conversion from a sourceLeadId on direct creates", () => {
    expect(
      resolveDealCreationPolicy({
        companyId: "company-1",
        propertyId: "property-1",
        sourceLeadId: "lead-1",
      })
    ).toEqual({
      allowed: false,
      origin: "direct",
      reason: "Use the lead conversion endpoint to create deals from leads",
    });
  });

  it("keeps migration mode as an explicit bypass", () => {
    expect(resolveDealCreationPolicy({ migrationMode: true, sourceLeadId: null })).toEqual({
      allowed: true,
      origin: "migration",
    });
  });

  it("treats creationContext migration as the same bypass as legacy migrationMode", () => {
    expect(resolveDealCreationPolicy({ creationContext: "migration", sourceLeadId: null })).toEqual({
      allowed: true,
      origin: "migration",
    });
  });
});
