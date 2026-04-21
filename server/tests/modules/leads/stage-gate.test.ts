import { describe, expect, it } from "vitest";

async function loadStageGateModule() {
  try {
    return await import("../../../src/modules/leads/stage-gate.js");
  } catch {
    return null;
  }
}

const currentStage = {
  id: "stage-current",
  name: "Current",
  slug: "company_pre_qualified",
  displayOrder: 2,
  isTerminal: false,
  isActivePipeline: true,
};

describe("Lead Stage Gate Evaluation", () => {
  it("blocks advancement into lead_go_no_go when pre-qual value is missing", async () => {
    const mod = await loadStageGateModule();

    expect(mod).not.toBeNull();

    const result = mod!.evaluateLeadStageGate({
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

    expect(result.allowed).toBe(false);
    expect(result.missingRequirements.fields).toContain("estimatedOpportunityValue");
  });

  it("blocks conversion readiness when partial scoping subset is incomplete", async () => {
    const mod = await loadStageGateModule();

    expect(mod).not.toBeNull();

    const result = mod!.evaluateLeadStageGate({
      lead: {
        id: "lead-1",
        companyId: "company-1",
        propertyId: "property-1",
        source: "Referral",
      },
      qualification: {
        estimatedOpportunityValue: "42000.00",
        goDecision: "go",
        goDecisionNotes: "Proceed",
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
    expect(result.missingRequirements.fields).toContain("scopingSubset.projectOverview");
  });

  it("requires property and checklist metadata before pre-qual value assignment", async () => {
    const mod = await loadStageGateModule();

    expect(mod).not.toBeNull();

    const result = mod!.evaluateLeadStageGate({
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
});
