import { describe, expect, it } from "vitest";
import { evaluateScopingReadiness } from "../../../src/modules/deals/scoping-rules.js";

describe("evaluateScopingReadiness", () => {
  it("requires at least one selected scope item", () => {
    const result = evaluateScopingReadiness({
      currentStatus: "draft",
      workflowRoute: "normal",
      projectTypeId: null,
      sectionData: {
        projectOverview: {
          propertyName: "Palm Villas",
          bidDueDate: "2026-05-01",
        },
        propertyDetails: {
          propertyAddress: "123 Palm Way",
        },
        scope: {
          selectedProjectTypeIds: [],
        },
        scopeSummary: {
          summary: "Exterior renovation",
        },
        opportunity: {
          preBidMeetingCompleted: "yes",
          siteVisitDecision: "not_required",
        },
      },
      attachmentKeys: [],
    });

    expect(result.errors.sections.scope).toEqual(["selectedProjectTypeIds"]);
    expect(result.status).toBe("draft");
  });

  it("accepts a legacy project type as the selected scope item and does not require attachments", () => {
    const result = evaluateScopingReadiness({
      currentStatus: "draft",
      workflowRoute: "normal",
      projectTypeId: "pt-roofing",
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
          siteVisitDecision: "not_required",
        },
      },
      attachmentKeys: [],
    });

    expect(result.errors.sections.scope).toBeUndefined();
    expect(result.errors.attachments).toEqual({});
    expect(result.requiredAttachmentKeys).toEqual([]);
    expect(result.status).toBe("ready");
  });

  it("requires opportunity review fields for estimating-routed work", () => {
    const result = evaluateScopingReadiness({
      currentStatus: "draft",
      workflowRoute: "normal",
      projectTypeId: "pt-1",
      sectionData: {
        scope: {
          selectedProjectTypeIds: ["pt-1"],
        },
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
      attachmentKeys: [],
    });

    expect(result.errors.sections.opportunity).toEqual([
      "preBidMeetingCompleted",
      "siteVisitDecision",
    ]);
  });

  it("requires a completed site visit when opportunity review marks it required", () => {
    const result = evaluateScopingReadiness({
      currentStatus: "draft",
      workflowRoute: "normal",
      projectTypeId: "pt-1",
      sectionData: {
        scope: {
          selectedProjectTypeIds: ["pt-1"],
        },
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
      attachmentKeys: [],
    });

    expect(result.errors.sections.opportunity).toEqual(["siteVisitCompleted"]);
  });

  it("requires a completed site visit for scheduled or reviewing site visit decisions", () => {
    for (const siteVisitDecision of ["scheduled", "reviewing"] as const) {
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
            preBidMeetingCompleted: "completed",
            siteVisitDecision,
            siteVisitCompleted: "",
          },
        },
        attachmentKeys: ["scope_docs", "site_photos"],
      });

      expect(result.errors.sections.opportunity).toEqual(["siteVisitCompleted"]);
    }
  });

  it("does not require opportunity review fields for service-routed work", () => {
    const result = evaluateScopingReadiness({
      currentStatus: "draft",
      workflowRoute: "service",
      projectTypeId: "pt-1",
      sectionData: {
        scope: {
          selectedProjectTypeIds: ["pt-1"],
        },
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
      attachmentKeys: [],
    });

    expect(result.errors.sections.opportunity).toBeUndefined();
  });
});
