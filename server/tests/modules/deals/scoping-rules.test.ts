import { describe, expect, it } from "vitest";
import { evaluateScopingReadiness } from "../../../src/modules/deals/scoping-rules.js";

describe("evaluateScopingReadiness", () => {
  it("requires opportunity review fields for estimating-routed work", () => {
    const result = evaluateScopingReadiness({
      currentStatus: "draft",
      workflowRoute: "estimating",
      projectTypeId: "pt-1",
      sectionData: {
        projectOverview: {
          propertyName: "Palm Villas",
          bidDueDate: "2026-05-01",
        },
        propertyDetails: {
          propertyAddress: "123 Palm Way",
        },
        scopeSummary: {
          summary: "Exterior renovation",
        },
        opportunity: {},
      },
      attachmentKeys: ["scope_docs", "site_photos"],
    });

    expect(result.errors.sections.opportunity).toEqual([
      "preBidMeetingCompleted",
      "siteVisitDecision",
    ]);
  });

  it("requires a completed site visit when opportunity review marks it required", () => {
    const result = evaluateScopingReadiness({
      currentStatus: "draft",
      workflowRoute: "estimating",
      projectTypeId: "pt-1",
      sectionData: {
        projectOverview: {
          propertyName: "Palm Villas",
          bidDueDate: "2026-05-01",
        },
        propertyDetails: {
          propertyAddress: "123 Palm Way",
        },
        scopeSummary: {
          summary: "Exterior renovation",
        },
        opportunity: {
          preBidMeetingCompleted: "yes",
          siteVisitDecision: "required",
          siteVisitCompleted: "",
        },
      },
      attachmentKeys: ["scope_docs", "site_photos"],
    });

    expect(result.errors.sections.opportunity).toEqual(["siteVisitCompleted"]);
  });

  it("does not require opportunity review fields for service-routed work", () => {
    const result = evaluateScopingReadiness({
      currentStatus: "draft",
      workflowRoute: "service",
      projectTypeId: "pt-1",
      sectionData: {
        projectOverview: {
          propertyName: "Palm Villas",
        },
        propertyDetails: {
          propertyAddress: "123 Palm Way",
        },
        scopeSummary: {
          summary: "Exterior renovation",
        },
        opportunity: {},
      },
      attachmentKeys: ["site_photos"],
    });

    expect(result.errors.sections.opportunity).toBeUndefined();
  });
});
