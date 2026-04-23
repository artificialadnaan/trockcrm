import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { DealListPage } from "./deal-list-page";

const mocks = vi.hoisted(() => ({
  useDealBoardMock: vi.fn(),
  usePipelineStagesMock: vi.fn(),
}));

vi.mock("@/hooks/use-deals", () => ({
  useDealBoard: mocks.useDealBoardMock,
}));

vi.mock("@/lib/pipeline-ownership", () => ({
  getDealBoardStageSlugs: vi.fn(() => [
    "opportunity",
    "estimate_in_progress",
    "estimate_under_review",
    "estimate_sent_to_client",
    "sent_to_production",
    "production_lost",
  ]),
  getDealStageLabelBySlug: vi.fn((slug: string) => {
    const labels: Record<string, string> = {
      opportunity: "Opportunity",
      estimate_in_progress: "Estimate in Progress",
      estimate_under_review: "Estimate Under Review",
      estimate_sent_to_client: "Estimate Sent to Client",
      sent_to_production: "Sent to Production",
      production_lost: "Production Lost",
    };
    return labels[slug] ?? slug;
  }),
  getDealColumnOwnership: vi.fn((stage: { slug: string }) => {
    if (stage.slug === "opportunity") {
      return { label: "CRM editable", tone: "crm" };
    }
    if (stage.slug === "estimate_in_progress") {
      return { label: "Bid Board mirror", secondaryLabel: "Read-only in CRM", tone: "mirror" };
    }
    return null;
  }),
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
      const isMirroredStage = [
        "estimate_in_progress",
        "service_estimating",
        "estimate_under_review",
        "estimate_sent_to_client",
        "sent_to_production",
        "service_sent_to_production",
        "production_lost",
        "service_lost",
      ].includes(slug ?? "");
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
  normalizeDealStageSlug: vi.fn((slug: string) => {
    const map: Record<string, string> = {
      estimating: "estimate_in_progress",
      bid_sent: "estimate_sent_to_client",
      in_production: "sent_to_production",
      close_out: "sent_to_production",
      closed_won: "sent_to_production",
      closed_lost: "production_lost",
    };
    return map[slug] ?? slug;
  }),
}));

vi.mock("@/hooks/use-pipeline-config", () => ({
  usePipelineStages: mocks.usePipelineStagesMock,
}));

vi.mock("@/lib/pipeline-scope", () => ({
  useNormalizedPipelineRoute: () => ({
    allowedScope: "all",
    needsRedirect: false,
    redirectTo: "/deals?scope=all",
  }),
}));

vi.mock("@/components/deals/deal-stage-badge", () => ({
  DealStageBadge: ({ stageId }: { stageId: string }) => <span>{stageId}</span>,
}));

vi.mock("@/components/pipeline/pipeline-board", () => ({
  PipelineBoard: ({ columns }: { columns: Array<{ stage: { name: string }; count: number }> }) => (
    <div>{columns.map((column) => `${column.stage.name}:${column.count}`).join(" | ")}</div>
  ),
}));

vi.mock("@/components/deals/stage-change-dialog", () => ({
  StageChangeDialog: () => null,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));

vi.mock("@/lib/deal-utils", () => ({
  formatCurrencyCompact: vi.fn((value: number) => `$${value.toLocaleString("en-US")}`),
}));

vi.mock("@/lib/pipeline-board-summary", () => ({
  buildDealBoardSummary: vi.fn(() => ({
    totalValue: 272000,
    totalCount: 2,
    averageAgeDays: 12,
    liveStageCount: 2,
  })),
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
    mocks.useDealBoardMock.mockReset();
    mocks.usePipelineStagesMock.mockReset();

    mocks.usePipelineStagesMock.mockReturnValue({
      stages: [
        {
          id: "stage-opportunity",
          name: "Opportunity",
          slug: "opportunity",
          workflowFamily: "standard_deal",
          displayOrder: 1,
          isActivePipeline: true,
          isTerminal: false,
        },
        {
          id: "stage-estimating",
          name: "Estimate in Progress",
          slug: "estimate_in_progress",
          workflowFamily: "standard_deal",
          displayOrder: 2,
          isActivePipeline: true,
          isTerminal: false,
        },
        {
          id: "stage-service-estimating",
          name: "Service - Estimating",
          slug: "service_estimating",
          workflowFamily: "service_deal",
          displayOrder: 2,
          isActivePipeline: true,
          isTerminal: false,
        },
      ],
    });

    mocks.useDealBoardMock.mockReturnValue({
      board: {
        columns: [
          {
            stage: { id: "stage-opportunity", name: "Opportunity", slug: "opportunity" },
            count: 1,
            totalValue: 180000,
            cards: [makeDeal()],
          },
          {
            stage: { id: "stage-estimating", name: "Estimate in Progress", slug: "estimate_in_progress" },
            count: 1,
            totalValue: 92000,
            cards: [
              makeDeal({
                id: "deal-2",
                dealNumber: "TR-2026-0002",
                name: "Service Hospital Roof",
                stageId: "stage-service-estimating",
                workflowRoute: "service",
                bidEstimate: "92000",
                ddEstimate: null,
                isBidBoardOwned: true,
                bidBoardStageSlug: "service_estimating",
                readOnlySyncedAt: "2026-04-21T08:00:00.000Z",
              }),
            ],
          },
        ],
        terminalStages: [],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
  });

  it("distinguishes CRM-owned opportunity work from Bid Board mirrored downstream stages", () => {
    const html = renderPage();

    expect(mocks.useDealBoardMock).toHaveBeenCalledWith(
      "all",
      true
    );
    expect(html).toContain("Opportunity");
    expect(html).toContain("Estimate in Progress");
    expect(html).toContain("Active deals");
    expect(html).toContain("Avg. stage age");
    expect(html).toContain("Live stages");
    expect(html).toContain("New Deal");
  });

  it("keeps mirrored columns read-only without stripping the empty CRM-owned opportunity column", () => {
    mocks.useDealBoardMock.mockReturnValue({
      board: {
        columns: [
          {
            stage: { id: "stage-estimating", name: "Estimate in Progress", slug: "estimate_in_progress" },
            count: 1,
            totalValue: 180000,
            cards: [
              makeDeal({
                id: "deal-3",
                dealNumber: "TR-2026-0003",
                stageId: "stage-estimating",
                workflowRoute: "normal",
                isBidBoardOwned: true,
                bidBoardStageSlug: "estimate_in_progress",
                readOnlySyncedAt: "2026-04-22T08:00:00.000Z",
              }),
            ],
          },
        ],
        terminalStages: [],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = renderPage();

    expect(html).toContain("Opportunity");
    expect(html).toContain("Estimate in Progress");
  });
});
