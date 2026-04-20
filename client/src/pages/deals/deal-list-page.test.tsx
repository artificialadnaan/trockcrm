import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { DealListPage } from "./deal-list-page";

const allDeals = [
  {
    id: "deal-dd",
    dealNumber: "TR-1001",
    name: "Due Diligence Deal",
    stageId: "stage-dd",
    workflowRoute: "estimating",
    assignedRepId: "rep-1",
    companyId: "company-1",
    propertyId: "property-1",
    sourceLeadId: null,
    primaryContactId: null,
    ddEstimate: "50000",
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
    stageEnteredAt: "2026-04-20T10:00:00.000Z",
    isActive: true,
    hubspotDealId: null,
    createdAt: "2026-04-20T10:00:00.000Z",
    updatedAt: "2026-04-20T10:00:00.000Z",
  },
  {
    id: "deal-est",
    dealNumber: "TR-1002",
    name: "Estimating Deal",
    stageId: "stage-estimating",
    workflowRoute: "estimating",
    assignedRepId: "rep-1",
    companyId: "company-1",
    propertyId: "property-1",
    sourceLeadId: null,
    primaryContactId: null,
    ddEstimate: "50000",
    bidEstimate: "75000",
    awardedAmount: null,
    changeOrderTotal: null,
    description: null,
    propertyAddress: null,
    propertyCity: "Austin",
    propertyState: "TX",
    propertyZip: null,
    projectTypeId: null,
    regionId: null,
    source: null,
    winProbability: null,
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
    stageEnteredAt: "2026-04-20T10:00:00.000Z",
    isActive: true,
    hubspotDealId: null,
    createdAt: "2026-04-20T10:00:00.000Z",
    updatedAt: "2026-04-20T10:00:00.000Z",
  },
];

vi.mock("@/hooks/use-deals", () => ({
  useDeals: (filters: { stageIds?: string[] } = {}) => {
    const stageIds = filters.stageIds ?? [];
    const deals = stageIds.length > 0 ? allDeals.filter((deal) => stageIds.includes(deal.stageId)) : allDeals;
    return {
      deals,
      pagination: { total: deals.length, page: 1, limit: 25, totalPages: 1 },
      loading: false,
      error: null,
      refetch: vi.fn(),
    };
  },
}));

vi.mock("@/hooks/use-deal-filters", () => ({
  useDealFilters: () => ({
    filters: { isActive: true, sortBy: "updated_at", sortDir: "desc", page: 1, limit: 25 },
    setFilters: vi.fn(),
    resetFilters: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-pipeline-config", () => ({
  usePipelineStages: () => ({
    stages: [
      { id: "stage-dd", name: "DD", slug: "dd" },
      { id: "stage-estimating", name: "Estimating", slug: "estimating" },
      { id: "stage-bid-sent", name: "Bid Sent", slug: "bid_sent" },
    ],
    loading: false,
  }),
}));

vi.mock("@/components/deals/deal-filters", () => ({
  DealFilters: () => <div>Deal Filters</div>,
}));

function normalize(html: string) {
  return html.replace(/\s+/g, " ").trim();
}

describe("DealListPage", () => {
  it("accepts due diligence and estimating bucket filters from the URL", () => {
    const ddHtml = normalize(
      renderToStaticMarkup(
        <MemoryRouter initialEntries={["/deals?bucket=due_diligence"]}>
          <DealListPage />
        </MemoryRouter>
      )
    );

    const estimatingHtml = normalize(
      renderToStaticMarkup(
        <MemoryRouter initialEntries={["/deals?bucket=estimating"]}>
          <DealListPage />
        </MemoryRouter>
      )
    );

    expect(ddHtml).toContain("Due Diligence Deal");
    expect(ddHtml).not.toContain("Estimating Deal");
    expect(estimatingHtml).toContain("Estimating Deal");
    expect(estimatingHtml).not.toContain("Due Diligence Deal");
  });
});
