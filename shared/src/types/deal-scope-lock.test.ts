import { describe, expect, it } from "vitest";

import {
  getScopeLockedDealPatchFields,
  getScopeLockedResolvedFields,
} from "./deal-scope-lock.js";

describe("deal scope lock comparisons", () => {
  it("ignores unchanged locked deal fields in full payload saves", () => {
    expect(
      getScopeLockedDealPatchFields(
        {
          description: "Updated description",
          name: "Same deal",
          projectTypeId: "project-type-1",
          workflowRoute: "normal",
        },
        {
          description: "Old description",
          name: "Same deal",
          projectTypeId: "project-type-1",
          workflowRoute: "normal",
        }
      )
    ).toEqual([]);
  });

  it("flags changed locked deal fields when values differ semantically", () => {
    expect(
      getScopeLockedDealPatchFields(
        {
          name: "Renamed deal",
          projectTypeId: "2",
        },
        {
          name: "Same deal",
          projectTypeId: 1,
        }
      )
    ).toEqual(["name", "projectTypeId"]);
  });

  it("keeps company and property relationship changes outside the post-RFP scope lock", () => {
    expect(
      getScopeLockedDealPatchFields(
        {
          companyId: "company-2",
          propertyId: "property-2",
        },
        {
          companyId: "company-1",
          propertyId: "property-1",
        }
      )
    ).toEqual([]);

    expect(
      getScopeLockedResolvedFields(
        {
          companyId: "company-2",
          propertyId: "property-2",
        },
        {
          companyId: "company-1",
          propertyId: "property-1",
        }
      )
    ).toEqual([]);
  });

  it("treats numeric-looking locked strings as exact strings", () => {
    expect(
      getScopeLockedDealPatchFields(
        {
          name: "12",
          workflowRoute: "normal",
        },
        {
          name: "0012",
          workflowRoute: "normal",
        }
      )
    ).toEqual(["name"]);

    expect(
      getScopeLockedDealPatchFields(
        {
          name: "12",
          workflowRoute: "normal",
        },
        {
          name: "12.0",
          workflowRoute: "normal",
        }
      )
    ).toEqual(["name"]);

    expect(
      getScopeLockedDealPatchFields(
        {
          name: "0012",
          workflowRoute: "normal",
        },
        {
          name: "0012",
          workflowRoute: "normal",
        }
      )
    ).toEqual([]);
  });

  it("treats whitespace differences in locked strings as real changes", () => {
    expect(
      getScopeLockedDealPatchFields(
        {
          name: " Acme",
          workflowRoute: "normal",
        },
        {
          name: "Acme",
          workflowRoute: "normal",
        }
      )
    ).toEqual(["name"]);

    expect(
      getScopeLockedDealPatchFields(
        {
          name: "Acme ",
          workflowRoute: "normal",
        },
        {
          name: "Acme",
          workflowRoute: "normal",
        }
      )
    ).toEqual(["name"]);
    
    expect(
      getScopeLockedResolvedFields(
        {
          estimatorConsultationNotes: " Existing notes",
        },
        {
          estimatorConsultationNotes: "Existing notes",
        }
      )
    ).toEqual(["estimatorConsultationNotes"]);
  });

  it("compares arrays order-independently for resolved fields", () => {
    expect(
      getScopeLockedResolvedFields(
        {
          propertyName: ["b", "a"],
        },
        {
          propertyName: ["a", "b"],
        }
      )
    ).toEqual([]);
  });
});
