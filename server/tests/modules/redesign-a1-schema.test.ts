import { describe, expect, it } from "vitest";
import {
  companies,
  contacts,
  properties,
  companyIndustryEnum,
  contactRoleEnum,
  propertyTypeEnum,
} from "@trock-crm/shared/schema";

describe("redesign A1 schema contract", () => {
  it("adds company tier-1 fields and industry enum values", () => {
    expect(companyIndustryEnum.enumValues).toEqual([
      "general_contractor",
      "construction_manager",
      "property_owner",
      "property_management",
      "reit",
      "architecture_engineering",
      "consultant",
      "insurance_restoration",
      "other",
    ]);

    expect(companies).toHaveProperty("industry");
    expect(companies).toHaveProperty("region");
    expect(companies).toHaveProperty("domain");
    expect(companies).toHaveProperty("lastActivityAt");
    expect(companies).toHaveProperty("hubspotId");
    expect(companies).toHaveProperty("procoreId");
  });

  it("adds contact tier-1 fields while reusing existing HubSpot contact id", () => {
    expect(contactRoleEnum.enumValues).toEqual([
      "owner_principal",
      "project_manager",
      "facilities_director",
      "maintenance",
      "procurement",
      "insurance_adjuster",
      "admin_ap",
      "other",
    ]);

    expect(contacts).toHaveProperty("role");
    expect(contacts).toHaveProperty("linkedinUrl");
    expect(contacts).toHaveProperty("hubspotContactId");
    expect(contacts).not.toHaveProperty("hubspotId");
    expect(contacts).not.toHaveProperty("isPrimary");
  });

  it("adds property tier-1 fields and type enum values", () => {
    expect(propertyTypeEnum.enumValues).toEqual([
      "office",
      "industrial",
      "retail",
      "school",
      "healthcare",
      "government",
      "mixed_use",
    ]);

    expect(properties).toHaveProperty("type");
    expect(properties).toHaveProperty("floors");
    expect(properties).toHaveProperty("roofArea");
    expect(properties).toHaveProperty("lastActivityAt");
    expect(properties).toHaveProperty("procoreId");
    expect(properties).toHaveProperty("companycamId");
  });
});
