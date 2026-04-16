import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EmailAssignmentQueueView } from "./email-assignment-queue-view";

describe("EmailAssignmentQueueView", () => {
  it("renders unresolved assignment details and reassignment actions", () => {
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
    expect(html).toContain("TR-2026-0002");
    expect(html).toContain("Resolve");
    expect(html).toContain("multiple_deal_candidates");
    expect(html).toContain("Lead · TR-2026-L001");
    expect(html).toContain("Property · 123 Main St");
  });

  it("renders an empty-state message when there are no items", () => {
    const html = renderToStaticMarkup(<EmailAssignmentQueueView items={[]} onAssign={async () => {}} />);
    expect(html).toContain("No unresolved email assignments.");
  });
});
