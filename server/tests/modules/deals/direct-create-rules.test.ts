import { describe, expect, it } from "vitest";
import { canCreateDealWithoutSourceLead } from "../../../src/modules/deals/direct-create-rules.js";

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
});
