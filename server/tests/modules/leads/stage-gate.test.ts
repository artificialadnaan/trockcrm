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
  it("blocks advancement into lead_go_no_go when the full lead scoping checklist is incomplete", () => {
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
      leadScopingReadiness: {
        status: "draft",
        isReadyForGoNoGo: false,
        completionState: {},
        errors: { sections: {}, attachments: {} },
      },
      currentStage,
      targetStage: {
        ...currentStage,
        id: "stage-go-no-go",
        slug: "lead_go_no_go",
        name: "Lead Go/No-Go",
      },
    });

    expect(result.allowed).toBe(false);
    expect(result.missingRequirements.fields).toContain("leadScoping.completedChecklist");
  });

  it("blocks qualification completion when go/no-go notes are missing", () => {
    const result = evaluateLeadStageGate({
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
      leadScopingReadiness: {
        status: "ready",
        isReadyForGoNoGo: true,
        completionState: {},
        errors: { sections: {}, attachments: {} },
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
      leadScopingReadiness: {
        status: "draft",
        isReadyForGoNoGo: false,
        completionState: {},
        errors: { sections: {}, attachments: {} },
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
});
