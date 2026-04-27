import { describe, expect, it } from "vitest";
import { evaluateLeadStageGate } from "../../../src/modules/leads/stage-gate.ts";

const currentStage = {
  id: "stage-current",
  name: "Current",
  slug: "company_pre_qualified",
  displayOrder: 2,
  isTerminal: false,
  isActivePipeline: true,
};

describe("Lead Stage Gate Evaluation", () => {
  it("blocks advancement into Qualified Lead until the canonical intake fields are present", () => {
    const result = evaluateLeadStageGate({
      lead: {
        id: "lead-1",
        companyId: "company-1",
        propertyId: "property-1",
        source: null,
      },
      qualification: {
        qualificationData: {},
        scopingSubsetData: {},
      },
      currentStage: {
        id: "stage-new",
        name: "New Lead",
        slug: "new_lead",
        displayOrder: 1,
        isTerminal: false,
        isActivePipeline: true,
      },
      targetStage: {
        id: "stage-qualified",
        name: "Qualified Lead",
        slug: "qualified_lead",
        displayOrder: 2,
        isTerminal: false,
        isActivePipeline: true,
      },
    });

    expect(result.allowed).toBe(false);
    expect(result.missingRequirements.fields).toEqual([
      "source",
      "projectTypeId",
      "qualificationPayload.existing_customer_status",
    ]);
  });

  it("treats sourceCategory as satisfying the lead source gate", () => {
    const result = evaluateLeadStageGate({
      lead: {
        id: "lead-1",
        companyId: "company-1",
        propertyId: "property-1",
        source: null,
        sourceCategory: "Referral",
        projectTypeId: "type-1",
        qualificationPayload: {
          existing_customer_status: "Existing",
        },
      },
      qualification: {
        qualificationData: {},
        scopingSubsetData: {},
      },
      currentStage: {
        id: "stage-new",
        name: "New Lead",
        slug: "new_lead",
        displayOrder: 1,
        isTerminal: false,
        isActivePipeline: true,
      },
      targetStage: {
        id: "stage-qualified",
        name: "Qualified Lead",
        slug: "qualified_lead",
        displayOrder: 2,
        isTerminal: false,
        isActivePipeline: true,
      },
    });

    expect(result.allowed).toBe(true);
    expect(result.missingRequirements.fields).toEqual([]);
  });

  it("does not require a lead-side scoping checklist to advance into the legacy go/no-go stage", () => {
    const result = evaluateLeadStageGate({
      lead: {
        id: "lead-1",
        companyId: "company-1",
        propertyId: "property-1",
        source: "Referral",
      },
      qualification: {
        estimatedOpportunityValue: "42000.00",
        qualificationData: {
          projectLocation: "Dallas, TX",
          propertyName: "Palm Villas",
          propertyAddress: "123 Palm Way",
          propertyCity: "Dallas",
          propertyState: "TX",
          unitCount: 120,
          stakeholderName: "Alex PM",
          stakeholderRole: "Property Manager",
          projectType: "Exterior Painting",
          scopeSummary: "Repaint all buildings",
          budgetStatus: "Budgeted",
          budgetQuarter: "Q2",
          specPackageStatus: "Provided",
          checklistStarted: true,
        },
        scopingSubsetData: {},
      },
      currentStage,
      targetStage: {
        ...currentStage,
        id: "stage-go-no-go",
        slug: "lead_go_no_go",
        name: "Lead Go/No-Go",
      },
    });

    expect(result.allowed).toBe(true);
    expect(result.missingRequirements.fields).toEqual([]);
  });

  it("blocks qualification completion when go/no-go notes are missing", () => {
    const result = evaluateLeadStageGate({
      userRole: "director",
      lead: {
        id: "lead-1",
        companyId: "company-1",
        propertyId: "property-1",
        source: "Referral",
      },
      qualification: {
        estimatedOpportunityValue: "42000.00",
        goDecision: "go",
        qualificationData: {
          projectLocation: "Dallas, TX",
          propertyName: "Palm Villas",
          propertyAddress: "123 Palm Way",
          propertyCity: "Dallas",
          propertyState: "TX",
          unitCount: 120,
          stakeholderName: "Alex PM",
          stakeholderRole: "Property Manager",
          projectType: "Exterior Painting",
          scopeSummary: "Repaint all buildings",
          budgetStatus: "Budgeted",
          budgetQuarter: "Q2",
          specPackageStatus: "Provided",
          checklistStarted: true,
        },
        scopingSubsetData: {
          propertyDetails: true,
          scopeSummary: true,
        },
      },
      currentStage,
      targetStage: {
        ...currentStage,
        id: "stage-qualified",
        slug: "qualified_for_opportunity",
        name: "Qualified for Opportunity",
      },
    });

    expect(result.allowed).toBe(false);
    expect(result.missingRequirements.fields).toContain("goDecisionNotes");
  });

  it("blocks reps from advancing a lead out of go/no-go even when approval fields are present", () => {
    const result = evaluateLeadStageGate({
      userRole: "rep",
      lead: {
        id: "lead-1",
        companyId: "company-1",
        propertyId: "property-1",
        source: "Referral",
      },
      qualification: {
        estimatedOpportunityValue: "42000.00",
        goDecision: "go",
        goDecisionNotes: "Approved for opportunity creation.",
        qualificationData: {
          projectLocation: "Dallas, TX",
          propertyName: "Palm Villas",
          propertyAddress: "123 Palm Way",
          propertyCity: "Dallas",
          propertyState: "TX",
          unitCount: 120,
          stakeholderName: "Alex PM",
          stakeholderRole: "Property Manager",
          projectType: "Exterior Painting",
          scopeSummary: "Repaint all buildings",
          budgetStatus: "Budgeted",
          budgetQuarter: "Q2",
          specPackageStatus: "Provided",
          checklistStarted: true,
        },
        scopingSubsetData: {},
      },
      currentStage: {
        ...currentStage,
        id: "stage-go-no-go",
        slug: "lead_go_no_go",
        name: "Lead Go/No-Go",
      },
      targetStage: {
        ...currentStage,
        id: "stage-qualified",
        slug: "qualified_for_opportunity",
        name: "Qualified for Opportunity",
      },
    });

    expect(result.allowed).toBe(false);
    expect(result.missingRequirements.fields).toContain("approval.directorAdmin");
    expect(result.blockReason).toContain("director");
  });

  it("requires property and checklist metadata before pre-qual value assignment", () => {
    const result = evaluateLeadStageGate({
      lead: {
        id: "lead-1",
        companyId: "company-1",
        propertyId: "property-1",
        source: "Referral",
      },
      qualification: {
        qualificationData: {
          projectLocation: "Dallas, TX",
          propertyName: "Palm Villas",
          propertyCity: "Dallas",
          propertyState: "TX",
          unitCount: 120,
          stakeholderName: "Alex PM",
          stakeholderRole: "Property Manager",
          projectType: "Exterior Painting",
          scopeSummary: "Repaint all buildings",
          budgetStatus: "Budgeted",
          budgetQuarter: "Q2",
          specPackageStatus: "Provided",
        },
        scopingSubsetData: {},
      },
      currentStage,
      targetStage: {
        ...currentStage,
        id: "stage-pre-qual",
        slug: "pre_qual_value_assigned",
        name: "Pre-Qual Value Assigned",
      },
    });

    expect(result.allowed).toBe(false);
    expect(result.missingRequirements.fields).toContain("qualification.propertyAddress");
    expect(result.missingRequirements.fields).toContain("qualification.checklistStarted");
  });

  it("merges V2 questionnaire missing items into the unified preflight result", () => {
    const result = evaluateLeadStageGate({
      lead: {
        id: "lead-1",
        companyId: "company-1",
        propertyId: "property-1",
        source: "Referral",
        sourceCategory: "Referral",
        projectTypeId: "type-1",
        qualificationPayload: {
          existing_customer_status: "Existing",
        },
      },
      qualification: {
        qualificationData: {},
        scopingSubsetData: {},
      },
      currentStage: {
        id: "stage-qualified",
        name: "Qualified Lead",
        slug: "qualified_lead",
        displayOrder: 2,
        isTerminal: false,
        isActivePipeline: true,
      },
      targetStage: {
        id: "stage-sales-validation",
        name: "Sales Validation",
        slug: "sales_validation_stage",
        displayOrder: 3,
        isTerminal: false,
        isActivePipeline: true,
      },
      questionnaireGate: {
        qualificationFields: ["estimated_value", "timeline_status"],
        projectTypeQuestionIds: ["roof_age_years"],
      },
    });

    expect(result.allowed).toBe(false);
    expect(result.missingRequirements.fields).toEqual([
      "qualificationPayload.estimated_value",
      "qualificationPayload.timeline_status",
      "question.roof_age_years",
    ]);

    const checklistKeys = result.missingRequirements.effectiveChecklist.fields.map((f) => f.key);
    expect(checklistKeys).toContain("qualificationPayload.estimated_value");
    expect(checklistKeys).toContain("qualificationPayload.timeline_status");
    expect(checklistKeys).toContain("question.roof_age_years");

    const unsatisfiedKeys = result.missingRequirements.effectiveChecklist.fields
      .filter((f) => !f.satisfied)
      .map((f) => f.key);
    expect(unsatisfiedKeys).toEqual(
      expect.arrayContaining([
        "qualificationPayload.estimated_value",
        "qualificationPayload.timeline_status",
        "question.roof_age_years",
      ])
    );

    const roofAgeRow = result.missingRequirements.effectiveChecklist.fields.find(
      (f) => f.key === "question.roof_age_years"
    );
    expect(roofAgeRow?.label).toBe("Roof Age Years");
  });

  it("returns allowed when V2 questionnaire gate has no missing items and V1 fields are satisfied", () => {
    const result = evaluateLeadStageGate({
      lead: {
        id: "lead-1",
        companyId: "company-1",
        propertyId: "property-1",
        source: "Referral",
        sourceCategory: "Referral",
        projectTypeId: "type-1",
        qualificationPayload: {
          existing_customer_status: "Existing",
          estimated_value: 100000,
          timeline_status: "2026-09-01",
        },
      },
      qualification: {
        qualificationData: {},
        scopingSubsetData: {},
      },
      currentStage: {
        id: "stage-qualified",
        name: "Qualified Lead",
        slug: "qualified_lead",
        displayOrder: 2,
        isTerminal: false,
        isActivePipeline: true,
      },
      targetStage: {
        id: "stage-sales-validation",
        name: "Sales Validation",
        slug: "sales_validation_stage",
        displayOrder: 3,
        isTerminal: false,
        isActivePipeline: true,
      },
      questionnaireGate: {
        qualificationFields: [],
        projectTypeQuestionIds: [],
      },
    });

    expect(result.allowed).toBe(true);
    expect(result.missingRequirements.fields).toEqual([]);
    expect(result.blockReason).toBeUndefined();
  });
});
