import { describe, expect, it } from "vitest";
import { validateLeadStageTransition } from "../../../src/modules/leads/stage-transition-service.js";

describe("stage-transition-service", () => {
  it("requires source, project type, and existing-customer resolution before moving into Qualified Lead", () => {
    const result = validateLeadStageTransition({
      lead: {
        id: "lead-1",
        stageId: "stage-new",
        stageSlug: "new_lead",
        source: null,
        projectTypeId: null,
        qualificationPayload: {},
        projectTypeQuestionPayload: {
          projectTypeId: null,
          answers: {},
        },
      },
      currentStage: {
        id: "stage-new",
        slug: "new_lead",
        name: "New Lead",
        isTerminal: false,
        displayOrder: 1,
      },
      targetStage: {
        id: "stage-qualified",
        slug: "qualified_lead",
        name: "Qualified Lead",
        isTerminal: false,
        displayOrder: 2,
      },
      projectTypeSlug: null,
    });

    expect(result.allowed).toBe(false);
    expect(result.missingRequirements.prerequisiteFields).toEqual([
      "source",
      "projectTypeId",
      "qualificationPayload.existing_customer_status",
    ]);
    expect(result.missingRequirements.qualificationFields).toEqual([]);
    expect(result.missingRequirements.projectTypeQuestionIds).toEqual([]);
  });

  it("blocks moving into opportunity when Sales Validation Stage questions are missing", () => {
    const result = validateLeadStageTransition({
      lead: {
        id: "lead-1",
        stageId: "stage-sales-validation",
        stageSlug: "sales_validation_stage",
        projectTypeId: "project-type-service",
        qualificationPayload: {
          existing_customer_status: "existing",
        },
        projectTypeQuestionPayload: {
          projectTypeId: "project-type-service",
          answers: {
            service_line: "Roof repair",
            service_urgency: "",
            site_contact_available: true,
          },
        },
      },
      currentStage: {
        id: "stage-sales-validation",
        slug: "sales_validation_stage",
        name: "Sales Validation Stage",
        isTerminal: false,
        displayOrder: 2,
      },
      targetStage: {
        id: "stage-opportunity",
        slug: "opportunity",
        name: "Opportunity",
        isTerminal: false,
        displayOrder: 3,
      },
      projectTypeSlug: "service",
    });

    expect(result.allowed).toBe(false);
    expect(result.code).toBe("LEAD_STAGE_REQUIREMENTS_UNMET");
    expect(result.missingRequirements.qualificationFields).toEqual([
      "estimated_value",
      "timeline_status",
    ]);
    expect(result.missingRequirements.projectTypeQuestionIds).toEqual([
      "service_urgency",
      "active_issue_summary",
      "service_request_value",
    ]);
  });

  it("allows moves when the qualification fields and project-type questions are all answered", () => {
    const result = validateLeadStageTransition({
      lead: {
        id: "lead-1",
        stageId: "stage-sales-validation",
        stageSlug: "sales_validation_stage",
        projectTypeId: "project-type-commercial",
        qualificationPayload: {
          existing_customer_status: "new",
          estimated_value: 120000,
          timeline_status: "this_quarter",
        },
        projectTypeQuestionPayload: {
          projectTypeId: "project-type-commercial",
          answers: {
            project_scope: "Reclad exterior envelope",
            decision_maker: "Facilities director",
            budget_status: "Approved",
            timeline_target: "Q3 2026",
            incumbent_vendor: "None",
          },
        },
      },
      currentStage: {
        id: "stage-sales-validation",
        slug: "sales_validation_stage",
        name: "Sales Validation Stage",
        isTerminal: false,
        displayOrder: 2,
      },
      targetStage: {
        id: "stage-opportunity",
        slug: "opportunity",
        name: "Opportunity",
        isTerminal: false,
        displayOrder: 3,
      },
      projectTypeSlug: "commercial",
    });

    expect(result.allowed).toBe(true);
    expect(result.missingRequirements.qualificationFields).toEqual([]);
    expect(result.missingRequirements.projectTypeQuestionIds).toEqual([]);
  });

  it("treats missing keys, null values, and blank strings as unanswered", () => {
    const result = validateLeadStageTransition({
      lead: {
        id: "lead-1",
        stageId: "stage-sales-validation",
        stageSlug: "sales_validation_stage",
        projectTypeId: null,
        qualificationPayload: {
          existing_customer_status: "existing",
          estimated_value: null,
          timeline_status: "   ",
        },
        projectTypeQuestionPayload: {
          projectTypeId: null,
          answers: {
            project_scope: "   ",
            decision_maker: null,
          },
        },
      },
      currentStage: {
        id: "stage-sales-validation",
        slug: "sales_validation_stage",
        name: "Sales Validation Stage",
        isTerminal: false,
        displayOrder: 2,
      },
      targetStage: {
        id: "stage-opportunity",
        slug: "opportunity",
        name: "Opportunity",
        isTerminal: false,
        displayOrder: 3,
      },
      projectTypeSlug: null,
    });

    expect(result.allowed).toBe(false);
    expect(result.missingRequirements.qualificationFields).toEqual([
      "estimated_value",
      "timeline_status",
    ]);
    expect(result.missingRequirements.projectTypeQuestionIds).toEqual([
      "project_scope",
      "decision_maker",
      "budget_status",
      "timeline_target",
      "incumbent_vendor",
    ]);
  });
});
