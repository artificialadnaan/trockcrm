import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OpportunityRoutingPanel } from "./opportunity-routing-panel";

vi.mock("@/hooks/use-deals", () => ({
  updateDeal: vi.fn(),
  applyOpportunityRoutingReview: vi.fn(),
}));

describe("OpportunityRoutingPanel", () => {
  it("shows routing review controls and department visibility", () => {
    const html = renderToStaticMarkup(
      <OpportunityRoutingPanel
        deal={{
          id: "deal-1",
          stageId: "stage-opportunity",
          pipelineDisposition: "opportunity",
          workflowRoute: null,
          ddEstimate: "42000",
          bidEstimate: "58000",
          departmentOwnership: {
            currentDepartment: "sales",
            acceptanceStatus: "pending",
            effectiveOwnerUserId: null,
            pendingDepartment: "estimating",
          },
          routingHistory: [],
        }}
        currentStageSlug="opportunity"
        onUpdated={vi.fn()}
      />
    );

    expect(html).toContain("Early Routing Review");
    expect(html).toContain("Post-Bid Routing Review");
    expect(html).toContain("Accountable Department");
    expect(html).toContain("Sales");
  });
});
