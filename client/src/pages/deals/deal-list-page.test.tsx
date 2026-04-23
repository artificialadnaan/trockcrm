import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { DealListPage } from "./deal-list-page";

const mocks = vi.hoisted(() => ({
  useDealBoardMock: vi.fn(),
  useDealFiltersMock: vi.fn(),
  usePipelineStagesMock: vi.fn(),
  useRegionsMock: vi.fn(),
}));

vi.mock("@/hooks/use-deals", () => ({
  useDealBoard: mocks.useDealBoardMock,
  getDealStageMetadata: vi.fn(
    (
      deal: {
        stageId: string;
        workflowRoute: "normal" | "service";
        isBidBoardOwned: boolean;
        bidBoardStageSlug: string | null;
        readOnlySyncedAt: string | null;
      },
      stages: Array<{ id: string; name: string; slug: string }>
    ) => {
      const stage = stages.find((entry) => entry.id === deal.stageId) ?? null;
      const slug = deal.bidBoardStageSlug ?? stage?.slug ?? null;
      const isMirroredStage = ["estimating", "bid_sent", "in_production", "close_out", "closed_won", "closed_lost"].includes(
        slug ?? ""
      );
      const isReadOnlyInCrm = isMirroredStage || Boolean(deal.isBidBoardOwned || deal.readOnlySyncedAt);

      return {
        stage,
        slug,
        label: stage?.name ?? "Deal",
        isOpportunityStage: slug === "opportunity",
        isMirroredStage,
        isReadOnlyInCrm,
        sourceOfTruth: isReadOnlyInCrm ? "bid_board" : "crm",
        routeLabel: deal.workflowRoute === "service" ? "Service" : "Normal",
      };
    }
  ),
  getWorkflowRouteLabel: vi.fn((route: "normal" | "service") => (route === "service" ? "Service" : "Normal")),
}));

vi.mock("@/lib/pipeline-ownership", () => ({
  getDealColumnOwnership: vi.fn((stage: { slug: string }) => {
    if (stage.slug === "opportunity") {
      return { label: "CRM editable", tone: "crm" };
    }
    if (stage.slug === "estimating") {
      return { label: "Bid Board mirror", secondaryLabel: "Read-only in CRM", tone: "mirror" };
    }
    return null;
  }),
}));

vi.mock("@/hooks/use-deal-filters", () => ({
  useDealFilters: mocks.useDealFiltersMock,
}));

vi.mock("@/hooks/use-pipeline-config", () => ({
  usePipelineStages: mocks.usePipelineStagesMock,
  useRegions: mocks.useRegionsMock,
}));

vi.mock("@/components/deals/deal-filters", () => ({
  DealFilters: () => <div>Deal Filters</div>,
}));

vi.mock("@/components/deals/deal-stage-badge", () => ({
  DealStageBadge: ({ stageId }: { stageId: string }) => <span>{stageId}</span>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/lib/deal-utils", () => ({
  formatCurrency: vi.fn((value: number) => `$${value.toLocaleString("en-US")}`),
  bestEstimate: vi.fn((deal: { ddEstimate?: string | null; bidEstimate?: string | null; awardedAmount?: string | null }) => {
    if (deal.awardedAmount) return Number(deal.awardedAmount);
    if (deal.bidEstimate) return Number(deal.bidEstimate);
    return Number(deal.ddEstimate ?? 0);
  }),
  daysInStage: vi.fn(() => 12),
  timeAgo: vi.fn(() => "2d ago"),
}));

function normalize(html: string) {
  return html.replace(/\s+/g, " ").trim();
}

function makeDeal(overrides: Record<string, unknown> = {}) {
  return {
    id: "deal-1",
    dealNumber: "TR-2026-0001",
    name: "Palm Villas",
    stageId: "stage-opportunity",
    workflowRoute: "normal",
    assignedRepId: "rep-1",
    companyId: "company-1",
    propertyId: "property-1",
    sourceLeadId: "lead-1",
    primaryContactId: null,
    ddEstimate: "180000",
    bidEstimate: null,
    awardedAmount: null,
    changeOrderTotal: null,
    description: null,
    propertyAddress: "123 Palm Way",
    propertyCity: "Dallas",
    propertyState: "TX",
    propertyZip: "75201",
    projectTypeId: null,
    regionId: "region-south",
    source: "referral",
    winProbability: 70,
    procoreProjectId: null,
    procoreBidId: null,
    procoreLastSyncedAt: null,
    isBidBoardOwned: false,
    bidBoardStageSlug: null,
    readOnlySyncedAt: null,
    lostReasonId: null,
    lostNotes: null,
    lostCompetitor: null,
    lostAt: null,
    expectedCloseDate: null,
    actualCloseDate: null,
    lastActivityAt: "2026-04-21T10:00:00.000Z",
    stageEnteredAt: "2026-04-10T10:00:00.000Z",
    isActive: true,
    hubspotDealId: null,
    createdAt: "2026-04-09T10:00:00.000Z",
    updatedAt: "2026-04-20T10:00:00.000Z",
    ...overrides,
  };
}

function renderPage() {
  return normalize(
    renderToStaticMarkup(
      <MemoryRouter>
        <DealListPage />
      </MemoryRouter>
    )
  );
}

describe("DealListPage", () => {
  beforeEach(() => {
    mocks.useDealFiltersMock.mockReset();
    mocks.useDealBoardMock.mockReset();
    mocks.usePipelineStagesMock.mockReset();
    mocks.useRegionsMock.mockReset();

    mocks.useDealFiltersMock.mockReturnValue({
      filters: {},
      setFilters: vi.fn(),
      resetFilters: vi.fn(),
    });

    mocks.usePipelineStagesMock.mockReturnValue({
      stages: [
        { id: "stage-opportunity", name: "Opportunity", slug: "opportunity", displayOrder: 1, isTerminal: false },
        { id: "stage-estimating", name: "Estimating", slug: "estimating", displayOrder: 2, isTerminal: false },
      ],
    });

    mocks.useRegionsMock.mockReturnValue({
      regions: [{ id: "region-south", name: "South Central" }],
      loading: false,
    });

    mocks.useDealBoardMock.mockReturnValue({
      deals: [
        makeDeal(),
        makeDeal({
          id: "deal-2",
          dealNumber: "TR-2026-0002",
          name: "Service Hospital Roof",
          stageId: "stage-estimating",
          workflowRoute: "service",
          bidEstimate: "92000",
          ddEstimate: null,
          isBidBoardOwned: true,
          bidBoardStageSlug: "estimating",
          readOnlySyncedAt: "2026-04-21T08:00:00.000Z",
        }),
      ],
      pagination: { page: 1, limit: 50, total: 2, totalPages: 1 },
      loading: false,
      error: null,
    });
  });

  it("distinguishes CRM-owned opportunity work from Bid Board mirrored downstream stages", () => {
    const html = renderPage();

    expect(mocks.useDealBoardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 1,
        limit: 100,
      })
    );
    expect(html).toContain("Opportunity");
    expect(html).toContain("CRM editable");
    expect(html).toContain("Estimating");
    expect(html).toContain("Bid Board mirror");
    expect(html).toContain("Read-only in CRM");
    expect(html).toContain("Normal");
    expect(html).toContain("Service");
    expect(html).toContain("South Central");
    expect(html).toContain("$180,000");
    expect(html).toContain("$92,000");
    expect(html).toContain("12d in stage");
  });

  it("does not promote a single per-deal ownership state into a column-wide CRM editable label", () => {
    mocks.useDealBoardMock.mockReturnValue({
      deals: [
        makeDeal({
          id: "deal-3",
          dealNumber: "TR-2026-0003",
          stageId: "stage-estimating",
          workflowRoute: "normal",
          isBidBoardOwned: false,
          bidBoardStageSlug: "estimating",
          readOnlySyncedAt: null,
        }),
      ],
      pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
      loading: false,
      error: null,
    });

    const html = renderPage();

    expect(html).toContain("Estimating");
    expect(html).toContain("Bid Board mirror");
    expect(html).not.toContain("CRM editable");
  });
});
