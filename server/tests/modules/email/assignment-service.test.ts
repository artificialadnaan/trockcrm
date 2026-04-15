import { describe, expect, it } from "vitest";
import { resolveEmailAssignment } from "../../../src/modules/email/assignment-service.js";

function dealCandidate(overrides: Record<string, unknown> = {}) {
  return {
    id: "deal-1",
    dealNumber: "TR-2026-0001",
    name: "Alpha Roof",
    companyId: "company-1",
    propertyAddress: "123 Main St",
    propertyCity: "Dallas",
    propertyState: "TX",
    propertyZip: "75201",
    ...overrides,
  } as const;
}

describe("resolveEmailAssignment", () => {
  it("lets an explicit deal number win", () => {
    const result = resolveEmailAssignment({
      subject: "Please review TR-2026-0002",
      bodyPreview: "Need an update on TR-2026-0002",
      contactCompanyId: "company-1",
      dealCandidates: [
        dealCandidate(),
        dealCandidate({
          id: "deal-2",
          dealNumber: "TR-2026-0002",
          name: "Beta Roof",
          propertyAddress: "500 Elm St",
          propertyCity: "Houston",
          propertyState: "TX",
          propertyZip: "77002",
        }),
      ],
    });

    expect(result).toMatchObject({
      assignedEntityType: "deal",
      assignedEntityId: "deal-2",
      assignedDealId: "deal-2",
      confidence: "high",
      ambiguityReason: null,
      matchedBy: "explicit_deal_number",
      requiresClassificationTask: false,
    });
  });

  it("lets a prior thread assignment win", () => {
    const result = resolveEmailAssignment({
      subject: "Follow-up on the project",
      bodyPreview: "Checking in on the latest status",
      contactCompanyId: "company-1",
      priorThreadAssignment: {
        assignedEntityType: "deal",
        assignedEntityId: "deal-thread",
        assignedDealId: "deal-thread",
      },
      dealCandidates: [
        dealCandidate({
          id: "deal-2",
          dealNumber: "TR-2026-0002",
          name: "Beta Roof",
        }),
      ],
    });

    expect(result).toMatchObject({
      assignedEntityType: "deal",
      assignedEntityId: "deal-thread",
      assignedDealId: "deal-thread",
      confidence: "high",
      ambiguityReason: null,
      matchedBy: "prior_thread_assignment",
      requiresClassificationTask: false,
    });
  });

  it("prefers a single matched deal over the company fallback", () => {
    const result = resolveEmailAssignment({
      subject: "Need a status update",
      bodyPreview: "Any update on the project?",
      contactCompanyId: "company-1",
      dealCandidates: [dealCandidate()],
    });

    expect(result).toMatchObject({
      assignedEntityType: "deal",
      assignedEntityId: "deal-1",
      assignedDealId: "deal-1",
      confidence: "high",
      ambiguityReason: null,
      matchedBy: "single_deal",
      requiresClassificationTask: false,
    });
  });

  it("resolves a single lead candidate when no deal candidates are available", () => {
    const result = resolveEmailAssignment({
      subject: "Lead follow-up",
      bodyPreview: "Checking in on the lead status",
      contactCompanyId: "company-1",
      dealCandidates: [],
      leadCandidates: [
        {
          id: "lead-1",
          leadNumber: "TR-2026-L001",
          name: "Alpha Lead",
          relatedDealId: null,
        },
      ],
    });

    expect(result).toMatchObject({
      assignedEntityType: "lead",
      assignedEntityId: "lead-1",
      assignedDealId: null,
      confidence: "high",
      ambiguityReason: null,
      matchedBy: "single_lead",
      requiresClassificationTask: false,
    });
  });

  it("resolves a single property candidate when it is the only property context", () => {
    const result = resolveEmailAssignment({
      subject: "Re: 123 Main St",
      bodyPreview: "Following up on the property only",
      contactCompanyId: "company-1",
      dealCandidates: [],
      propertyCandidates: [
        {
          id: "property-1",
          propertyAddress: "123 Main St",
          propertyCity: "Dallas",
          propertyState: "TX",
          propertyZip: "75201",
        },
      ],
    });

    expect(result).toMatchObject({
      assignedEntityType: "property",
      assignedEntityId: "property-1",
      assignedDealId: null,
      confidence: "high",
      ambiguityReason: null,
      matchedBy: "single_property",
      requiresClassificationTask: false,
    });
  });

  it("resolves a unique property match to the matching deal", () => {
    const result = resolveEmailAssignment({
      subject: "Re: 123 Main St Dallas TX 75201",
      bodyPreview: "Checking the roof at 123 Main St, Dallas, TX 75201",
      contactCompanyId: "company-1",
      dealCandidates: [
        dealCandidate(),
        dealCandidate({
          id: "deal-2",
          dealNumber: "TR-2026-0002",
          name: "Beta Roof",
          propertyAddress: "500 Elm St",
          propertyCity: "Houston",
          propertyState: "TX",
          propertyZip: "77002",
        }),
      ],
    });

    expect(result).toMatchObject({
      assignedEntityType: "property",
      assignedDealId: "deal-1",
      confidence: "high",
      ambiguityReason: null,
      matchedBy: "unique_property",
      requiresClassificationTask: false,
    });
  });

  it("falls back to company-only assignment and requests classification when matches are ambiguous", () => {
    const result = resolveEmailAssignment({
      subject: "General project question",
      bodyPreview: "Need help figuring out which project this belongs to",
      contactCompanyId: "company-1",
      propertyCandidates: [],
      dealCandidates: [
        dealCandidate(),
        dealCandidate({
          id: "deal-2",
          dealNumber: "TR-2026-0002",
          name: "Beta Roof",
        }),
      ],
    });

    expect(result).toMatchObject({
      assignedEntityType: "company",
      assignedEntityId: "company-1",
      assignedDealId: null,
      confidence: "low",
      ambiguityReason: "multiple_deal_candidates",
      matchedBy: "company_only",
      requiresClassificationTask: true,
    });
  });
});
