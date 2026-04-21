import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EmailAssignmentQueueView } from "./email-assignment-queue-view";

describe("EmailAssignmentQueueView", () => {
  it("renders parking-lot intake details with broader CRM target options", () => {
    const html = renderToStaticMarkup(
      <EmailAssignmentQueueView
        items={[
          {
            email: {
              id: "email-1",
              subject: "Question about TR-2026-0002",
              bodyPreview: "Need help with the right job",
              fromAddress: "customer@example.com",
              sentAt: "2026-04-15T14:00:00.000Z",
            },
            companyId: "company-1",
            contactName: "Casey Customer",
            companyName: "Alpha Roofing",
            candidateDeals: [
              { id: "deal-1", dealNumber: "TR-2026-0001", name: "Alpha Roof" },
              { id: "deal-2", dealNumber: "TR-2026-0002", name: "Beta Roof" },
            ],
            candidateLeads: [
              { id: "lead-1", leadNumber: "TR-2026-L001", name: "Alpha Lead", relatedDealId: "deal-1" },
            ],
            candidateProperties: [
              { id: "property-1", name: "123 Main St", relatedDealIds: ["deal-1"] },
            ],
            suggestedAssignment: {
              assignedEntityType: "company",
              assignedEntityId: "company-1",
              assignedDealId: null,
              confidence: "low",
              ambiguityReason: "multiple_deal_candidates",
              matchedBy: "company_only",
              requiresClassificationTask: true,
              candidateDealIds: ["deal-1", "deal-2"],
            },
          },
        ]}
        onAssign={async () => {}}
      />
    );

    expect(html).toContain("Casey Customer");
    expect(html).toContain("Question about TR-2026-0002");
    expect(html).toContain("Assign manually");
    expect(html).toContain("4 safe suggestions available");
    expect(html).toContain("multiple_deal_candidates");
    expect(html).toContain("Open manual assignment to use a suggestion or search anywhere in the CRM.");
    expect(html).toContain("Alpha Roofing");
    expect(html).toContain("Parking lot");
  });

  it("renders a manual assignment action when there are no safe suggestions", () => {
    const html = renderToStaticMarkup(
      <EmailAssignmentQueueView
        items={[
          {
            email: {
              id: "email-2",
              subject: "Receipt",
              bodyPreview: "Please keep this mail for your records.",
              fromAddress: "homedepot@order.homedepot.com",
              sentAt: "2026-04-20T19:03:34.000Z",
            },
            companyId: null,
            contactName: null,
            companyName: null,
            candidateDeals: [],
            candidateLeads: [],
            candidateProperties: [],
            candidateCompanies: [],
            suggestedAssignment: {
              assignedEntityType: null,
              assignedEntityId: null,
              assignedDealId: null,
              confidence: "low",
              ambiguityReason: "no_company_context",
              matchedBy: "company_only",
              requiresClassificationTask: true,
              candidateDealIds: [],
            },
          },
        ]}
        onAssign={async () => {}}
      />
    );

    expect(html).toContain("No safe match found");
    expect(html).toContain("Assign manually");
    expect(html).not.toContain("No safe assignment targets");
  });

  it("renders an empty-state message when there are no items", () => {
    const html = renderToStaticMarkup(<EmailAssignmentQueueView items={[]} onAssign={async () => {}} />);
    expect(html).toContain("No unresolved parking-lot email intake.");
  });
});
