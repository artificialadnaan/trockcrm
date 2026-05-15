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

  it("treats nullish and blank resolved values as equivalent absence", () => {
    expect(
      getScopeLockedResolvedFields(
        {
          siteVisitDecision: "   ",
          estimatorConsultationNotes: undefined,
        },
        {
          siteVisitDecision: null,
          estimatorConsultationNotes: null,
        }
      )
    ).toEqual([]);
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
