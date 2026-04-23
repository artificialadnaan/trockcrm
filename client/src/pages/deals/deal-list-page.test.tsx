import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { DealListPage } from "./deal-list-page";

vi.mock("@/hooks/use-deals", () => ({
  useDealBoard: () => ({
    board: {
      columns: [
        {
          stage: { id: "stage-est", name: "Estimating", slug: "estimating", displayOrder: 1 },
          count: 2,
          totalValue: 245000,
          cards: [
            {
              id: "deal-1",
              dealNumber: "TR-1001",
              name: "North Tower",
              stageId: "stage-est",
              pipelineDisposition: "deals",
              workflowRoute: "estimating",
              assignedRepId: "rep-1",
              companyId: null,
              propertyId: null,
              sourceLeadId: null,
              primaryContactId: null,
              ddEstimate: "245000",
              bidEstimate: null,
              awardedAmount: null,
              changeOrderTotal: null,
              description: null,
              propertyAddress: null,
              propertyCity: "Dallas",
              propertyState: "TX",
              propertyZip: null,
              projectTypeId: null,
              regionId: null,
              source: null,
              winProbability: null,
              decisionMakerName: null,
              decisionProcess: null,
              budgetStatus: null,
              incumbentVendor: null,
              unitCount: null,
              buildYear: null,
              forecastWindow: null,
              forecastCategory: null,
              forecastConfidencePercent: null,
              forecastRevenue: null,
              forecastGrossProfit: null,
              forecastBlockers: null,
              nextStep: null,
              nextStepDueAt: null,
              nextMilestoneAt: null,
              supportNeededType: null,
              supportNeededNotes: null,
              forecastUpdatedAt: null,
              forecastUpdatedBy: null,
              procoreProjectId: null,
              procoreBidId: null,
              procoreLastSyncedAt: null,
              lostReasonId: null,
              lostNotes: null,
              lostCompetitor: null,
              lostAt: null,
              expectedCloseDate: null,
              actualCloseDate: null,
              lastActivityAt: null,
              stageEnteredAt: "2026-04-19T12:00:00.000Z",
              isActive: true,
              hubspotDealId: null,
              createdAt: "2026-04-19T12:00:00.000Z",
              updatedAt: "2026-04-19T12:00:00.000Z",
            },
          ],
        },
        {
          stage: { id: "stage-bid", name: "Bid Sent", slug: "bid_sent", displayOrder: 2 },
          count: 1,
          totalValue: 75000,
          cards: [],
        },
      ],
      terminalStages: [],
    },
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/lib/pipeline-scope", () => ({
  useNormalizedPipelineRoute: () => ({
    allowedScope: "all",
    needsRedirect: false,
    redirectTo: "/deals?scope=all",
  }),
}));

vi.mock("@/components/deals/stage-change-dialog", () => ({
  StageChangeDialog: () => null,
}));

function normalize(html: string) {
  return html.replace(/\s+/g, " ").trim();
}

describe("DealListPage", () => {
  it("renders the restored board header and summary strip", () => {
    const html = normalize(
      renderToStaticMarkup(
        <MemoryRouter initialEntries={["/deals?scope=all"]}>
          <DealListPage />
        </MemoryRouter>
      )
    );

    expect(html).toContain("Deal Pipeline");
    expect(html).toContain("Live engine");
    expect(html).toContain("Total managed");
    expect(html).toContain("Active deals");
    expect(html).toContain("Avg. stage age");
    expect(html).toContain("New Deal");
    expect(html).toContain("Estimating");
    expect(html).toContain("Bid Sent");
  });
});
