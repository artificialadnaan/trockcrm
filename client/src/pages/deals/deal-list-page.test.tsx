// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import {
  DealListPage,
  buildDealStageNavigationPath,
  formatDateInput,
  getDashboardDealListView,
} from "./deal-list-page";

// jsdom does not implement ResizeObserver; KanbanScrollColumn + the kanban
// horizontal-scroll-sync layout effect both rely on it.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver =
  ResizeObserverStub as unknown as typeof ResizeObserver;

const mocks = vi.hoisted(() => ({
  useDealBoardMock: vi.fn(),
  useDealsMock: vi.fn(),
  usePipelineStagesMock: vi.fn(),
  useTaskAssigneesMock: vi.fn(),
  readTerminalDateFilterMock: vi.fn(),
  buildDealStageWorkspacePathMock: vi.fn(),
  useAuthMock: vi.fn(),
  dealsListSectionMock: vi.fn(),
}));

vi.mock("@/hooks/use-deals", () => ({
  useDealBoard: mocks.useDealBoardMock,
  useDeals: mocks.useDealsMock,
}));

vi.mock("@/hooks/use-pipeline-config", () => ({
  usePipelineStages: mocks.usePipelineStagesMock,
}));

vi.mock("@/hooks/use-task-assignees", () => ({
  useTaskAssignees: mocks.useTaskAssigneesMock,
}));

vi.mock("@/lib/auth", () => ({
  useAuth: mocks.useAuthMock,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, className }: { children: ReactNode; className?: string }) => (
    <button className={className}>{children}</button>
  ),
}));

vi.mock("@/components/deals/deals-list-section", () => ({
  DealsListSection: (props: Record<string, unknown>) => {
    mocks.dealsListSectionMock(props);
    return (
      <section data-testid="deals-list-section">
        <h2>{String(props.title ?? "Pipeline records")}</h2>
        <p>{String(props.eyebrow ?? "Deal list")}</p>
        <p>{String(props.searchPlaceholder ?? "")}</p>
        <p>{String(props.scope ?? "")}</p>
        <p>{String(props.pageSize ?? "")}</p>
        <p>{props.enableExport ? "Export" : "No export"}</p>
        <p>{props.enableDateFilter ? "Date filter enabled" : "Date filter disabled"}</p>
      </section>
    );
  },
}));

vi.mock("@/lib/pipeline-terminal-filters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pipeline-terminal-filters")>();
  return {
    ...actual,
    readTerminalDateFilter: mocks.readTerminalDateFilterMock,
    buildDealStageWorkspacePath: mocks.buildDealStageWorkspacePathMock,
  };
});

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
    assignedRepName: "Brett Jones",
    companyId: "company-1",
    companyName: "Acme Construction",
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

function renderPage(path = "/deals?scope=all", role = "admin") {
  mocks.useAuthMock.mockReturnValue({
    user: {
      id: "user-1",
      email: `${role}@example.test`,
      displayName: "Test User",
      role,
      officeId: "office-1",
      activeOfficeId: "office-1",
    },
    loading: false,
  });

  return normalize(
    renderToStaticMarkup(
      <MemoryRouter initialEntries={[path]}>
        <DealListPage />
      </MemoryRouter>
    )
  );
}

describe("DealListPage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-08T12:00:00Z"));
    mocks.useDealBoardMock.mockReset();
    mocks.useDealsMock.mockReset();
    mocks.usePipelineStagesMock.mockReset();
    mocks.useTaskAssigneesMock.mockReset();
    mocks.readTerminalDateFilterMock.mockReset();
    mocks.buildDealStageWorkspacePathMock.mockReset();
    mocks.useAuthMock.mockReset();
    mocks.dealsListSectionMock.mockReset();

    mocks.readTerminalDateFilterMock.mockImplementation((outcome: string) => ({
      preset: outcome === "won" ? "30" : "60",
    }));
    mocks.buildDealStageWorkspacePathMock.mockReturnValue("/deals/stages/stage-won?scope=all");

    mocks.useTaskAssigneesMock.mockReturnValue({
      assignees: [{ id: "rep-1", displayName: "Brett Jones" }],
    });

    mocks.usePipelineStagesMock.mockReturnValue({
      stages: [
        { id: "stage-opportunity", name: "Opportunity", slug: "opportunity", displayOrder: 1 },
        { id: "stage-estimating", name: "Estimating", slug: "estimating", displayOrder: 2 },
        { id: "stage-service-estimating", name: "Service Estimating", slug: "service_estimating", displayOrder: 2 },
        { id: "stage-under-review", name: "Estimate Under Review", slug: "estimate_under_review", displayOrder: 3 },
        { id: "stage-sent", name: "Estimate Sent to Client", slug: "estimate_sent_to_client", displayOrder: 4 },
        { id: "stage-contract", name: "Contract", slug: "contract", displayOrder: 5 },
        { id: "stage-won", name: "Won", slug: "won", displayOrder: 6 },
        { id: "stage-lost", name: "Lost", slug: "lost", displayOrder: 7 },
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
            stage: { id: "stage-service-estimating", name: "Service Estimating", slug: "service_estimating" },
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
              }),
            ],
          },
        ],
        terminalStages: [
          {
            stage: { id: "stage-won", name: "Won", slug: "won" },
            count: 1,
            deals: [makeDeal({ id: "deal-won", awardedAmount: "410000" })],
          },
        ],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    mocks.useDealsMock.mockReturnValue({
      deals: [makeDeal(), makeDeal({ id: "deal-2", name: "Service Hospital Roof", bidEstimate: "92000" })],
      pagination: { page: 1, limit: 25, total: 2, totalPages: 1 },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a readonly deal board with canonical stage labels", () => {
    const html = renderPage();

    expect(mocks.useDealBoardMock).toHaveBeenCalledWith("all", true, {
      won: { preset: "all" },
      lost: { preset: "all" },
    });
    expect(html).toContain("Read-only pipeline board");
    expect(html).toContain('placeholder="Search deals"');
    expect(html).toContain("Opportunity");
    expect(html).toContain("Estimating");
    expect(html).toContain("Service Estimating");
    expect(html).toContain("Contract");
    expect(html).toContain("Won");
    expect(html).toContain("Lost");
    expect(html).toContain("Estimate Sent to Client");
    expect(html).toContain("Palm Villas");
    expect(html).toContain("Service Hospital Roof");
  });

  it("renders the Service-only direct-create button in the Deals header without the old New Deal button", () => {
    const html = renderPage();

    expect(html).toContain("New Service Opportunity");
    expect(html).not.toContain("New Deal");
    expect(html).not.toContain("/deals/new");
  });

  it("excludes terminal-stage cards from the Active Pipeline value and count", () => {
    mocks.useDealBoardMock.mockReturnValue({
      board: {
        columns: [
          {
            stage: { id: "stage-opportunity", name: "Opportunity", slug: "opportunity" },
            count: 1,
            totalValue: 180000,
            cards: [makeDeal({ id: "deal-open", bidEstimate: "180000", awardedAmount: null })],
          },
          {
            stage: { id: "stage-won", name: "Won", slug: "won" },
            count: 1,
            totalValue: 410000,
            cards: [
              makeDeal({
                id: "deal-won",
                name: "Won Terminal Deal",
                stageId: "stage-won",
                awardedAmount: "410000",
                bidEstimate: null,
                ddEstimate: null,
              }),
            ],
          },
          {
            stage: { id: "stage-lost", name: "Lost", slug: "lost" },
            count: 1,
            totalValue: 92000,
            cards: [
              makeDeal({
                id: "deal-lost",
                name: "Lost Terminal Deal",
                stageId: "stage-lost",
                bidEstimate: "92000",
                ddEstimate: null,
              }),
              makeDeal({
                id: "deal-mirrored-terminal",
                name: "Mirrored Terminal Deal",
                stageId: "stage-opportunity",
                bidBoardStageSlug: "service_sent_to_production",
                bidEstimate: "900000",
                ddEstimate: null,
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

    expect(html).toContain("Active pipeline");
    expect(html).toMatch(/Active pipeline.*\$180\.0K.*1 deals/);
    expect(html).not.toContain("$1.6M");
    expect(html).not.toContain("4 deals");
  });

  it("uses backend column aggregates for Active Pipeline instead of truncated card arrays", () => {
    mocks.useDealBoardMock.mockReturnValue({
      board: {
        columns: [
          {
            stage: { id: "stage-opportunity", name: "Opportunity", slug: "opportunity" },
            count: 150,
            totalValue: 1500000,
            cards: Array.from({ length: 100 }, (_, index) =>
              makeDeal({
                id: `deal-open-${index}`,
                bidEstimate: "10000",
                awardedAmount: null,
                ddEstimate: null,
              })
            ),
          },
          {
            stage: { id: "stage-service", name: "Service Estimating", slug: "service_estimating" },
            count: 2,
            totalValue: 50000,
            cards: [
              makeDeal({
                id: "deal-service-1",
                name: "Service Deal",
                stageId: "stage-service",
                bidEstimate: "25000",
                awardedAmount: null,
                ddEstimate: null,
              }),
            ],
          },
          {
            stage: { id: "stage-won", name: "Won", slug: "won" },
            count: 80,
            totalValue: 800000,
            cards: [
              makeDeal({
                id: "deal-won",
                name: "Won Terminal Deal",
                stageId: "stage-won",
                awardedAmount: "800000",
                bidEstimate: null,
                ddEstimate: null,
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

    expect(html).toMatch(/Active pipeline.*\$1\.6M.*152 deals/);
    expect(html).not.toContain("101 deals");
  });

  it("renders decorated cards with project number fallback, avatar, company, SLA, and location", () => {
    mocks.useDealBoardMock.mockReturnValue({
      board: {
        columns: [
          {
            stage: { id: "stage-opportunity", name: "Opportunity", slug: "opportunity" },
            count: 2,
            totalValue: 180000,
            cards: [
              makeDeal({ id: "deal-pn", projectNumber: "DFW-1-12826-aa" }),
              makeDeal({
                id: "deal-fb",
                dealNumber: "HS-321687989951",
                projectNumber: null,
                assignedRepName: null,
                companyName: null,
              }),
              makeDeal({
                id: "deal-city-only",
                dealNumber: "TR-2026-0003",
                propertyCity: "Austin",
                propertyState: null,
              }),
              makeDeal({
                id: "deal-state-only",
                dealNumber: "TR-2026-0004",
                propertyCity: null,
                propertyState: "CA",
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

    expect(html).toContain("DFW-1-12826-aa");
    expect(html).toContain("Pending");
    expect(html).toContain("BJ");
    expect(html).toContain("TR");
    expect(html).toContain("Acme Construction");
    expect(html).toContain("Account pending");
    expect(html).toContain("SLA");
    expect(html).toContain("Dallas, TX");
    expect(html).toContain("Austin");
    expect(html).toContain("CA");
  });

  it("preserves empty canonical columns so stage parity remains visible", () => {
    mocks.useDealBoardMock.mockReturnValue({
      board: {
        columns: [
          {
            stage: { id: "stage-estimating", name: "Estimate in Progress", slug: "estimate_in_progress" },
            count: 1,
            totalValue: 180000,
            cards: [makeDeal({ id: "deal-3", stageId: "stage-estimating", bidBoardStageSlug: "estimate_in_progress" })],
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
    expect(html).toContain("Estimating");
    expect(html).toContain("No deals");
  });

  it("defaults exported terminal stage navigation to all time", () => {
    const column = {
      stage: { id: "stage-won", name: "Won", slug: "won" },
      count: 0,
      totalValue: 0,
      cards: [],
    };

    mocks.readTerminalDateFilterMock.mockImplementation((outcome: string) => ({
      preset: outcome === "won" ? "30" : "60",
    }));

    buildDealStageNavigationPath(column, "all");

    expect(mocks.readTerminalDateFilterMock).not.toHaveBeenCalled();
    expect(mocks.buildDealStageWorkspacePathMock).toHaveBeenLastCalledWith({
      stageId: "stage-won",
      stageSlug: "won",
      scope: "all",
      filters: {
        won: { preset: "all" },
        lost: { preset: "all" },
      },
    });
  });

  it("uses explicit terminal date filters when opening terminal stages", () => {
    const column = {
      stage: { id: "stage-won", name: "Won", slug: "won" },
      count: 0,
      totalValue: 0,
      cards: [],
    };

    const filters = {
      won: { preset: "30" as const },
      lost: { preset: "60" as const },
    };

    buildDealStageNavigationPath(column, "all", filters);

    expect(mocks.readTerminalDateFilterMock).not.toHaveBeenCalled();
    expect(mocks.buildDealStageWorkspacePathMock).toHaveBeenLastCalledWith({
      stageId: "stage-won",
      stageSlug: "won",
      scope: "all",
      filters,
    });
  });

  it("requests the selected terminal date filters for the deals board", () => {
    renderPage("/deals?scope=all&won_preset=30&lost_preset=60");

    expect(mocks.useDealBoardMock).toHaveBeenCalledWith("all", true, {
      won: { preset: "30" },
      lost: { preset: "60" },
    });
  });

  it("does not fire board fetch before auth resolves", () => {
    mocks.useAuthMock.mockReturnValue({
      user: null,
      loading: true,
    });
    mocks.useDealBoardMock.mockClear();

    const loadingHtml = normalize(
      renderToStaticMarkup(
        <MemoryRouter initialEntries={["/deals"]}>
          <DealListPage />
        </MemoryRouter>
      )
    );

    expect(loadingHtml).toContain("Loading deal board...");
    expect(mocks.useDealBoardMock).not.toHaveBeenCalled();

    renderPage("/deals", "director");

    expect(mocks.useDealBoardMock).toHaveBeenCalledWith("team", true, expect.any(Object));
  });

  it("uses the board terminal filters when building terminal stage navigation", () => {
    const column = {
      stage: { id: "stage-won", name: "Won", slug: "won" },
      count: 0,
      totalValue: 0,
      cards: [],
    };
    const boardFilters = {
      won: { preset: "custom" as const, customStart: "2026-01-01" },
      lost: { preset: "custom" as const, customStart: "2026-01-01" },
    };

    buildDealStageNavigationPath(column, "team", boardFilters);

    expect(mocks.readTerminalDateFilterMock).not.toHaveBeenCalled();
    expect(mocks.buildDealStageWorkspacePathMock).toHaveBeenLastCalledWith({
      stageId: "stage-won",
      stageSlug: "won",
      scope: "team",
      filters: boardFilters,
    });
  });

  it("defaults the board scope by role when the query param is absent", () => {
    renderPage("/deals", "rep");
    expect(mocks.useDealBoardMock).toHaveBeenLastCalledWith("mine", true, expect.any(Object));

    renderPage("/deals", "director");
    expect(mocks.useDealBoardMock).toHaveBeenLastCalledWith("team", true, expect.any(Object));

    renderPage("/deals", "admin");
    expect(mocks.useDealBoardMock).toHaveBeenLastCalledWith("all", true, expect.any(Object));

    renderPage("/deals?scope=mine", "director");
    expect(mocks.useDealBoardMock).toHaveBeenLastCalledWith("mine", true, expect.any(Object));
  });

  it("forces reps to mine scope even when ?scope=team is set", () => {
    const html = renderPage("/deals?scope=team", "rep");

    expect(mocks.useDealBoardMock).toHaveBeenLastCalledWith("mine", true, expect.any(Object));
    expect(html).toContain('aria-pressed="true">Mine');
    expect(html).toContain('aria-pressed="false">Team');
  });

  it("forces reps to mine scope even when ?scope=all is set", () => {
    const html = renderPage("/deals?scope=all", "rep");

    expect(mocks.useDealBoardMock).toHaveBeenLastCalledWith("mine", true, expect.any(Object));
    expect(html).toContain('aria-pressed="true">Mine');
    expect(html).toContain('aria-pressed="false">All');
  });

  it("embeds a scoped paginated exportable deal list below the kanban without date filters", () => {
    renderPage("/deals?scope=team", "director");

    expect(mocks.dealsListSectionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowFamily: "deal",
        scope: "team",
        enableExport: true,
        enableDateFilter: false,
        showFilterButton: true,
        pageSize: 20,
        searchPlaceholder: "Search deals or accounts",
      })
    );
  });

  it("builds the active pipeline drill-down view from dashboard query params", () => {
    const view = getDashboardDealListView({
      filterParam: "active",
      periodParam: "ytd",
      now: new Date("2026-05-08T12:00:00Z"),
    });

    expect(view.filter).toBe("active");
    expect(view.title).toBe("Active Pipeline");
    expect(view.subtitle).toContain("YTD");
    expect(view.boardMode).toBe("active");
    expect(view.listBaseFilters).toMatchObject({
      updatedFrom: "2026-01-01",
      updatedTo: "2026-05-08",
    });
    expect(view.listInitialSort).toEqual({ key: "updated_at", dir: "desc" });
  });

  it("supports today and week dashboard periods for rep drill-down links", () => {
    const todayView = getDashboardDealListView({
      filterParam: "active_pipeline",
      periodParam: "today",
      now: new Date("2026-05-08T12:00:00Z"),
    });
    const weekView = getDashboardDealListView({
      filterParam: "active_pipeline",
      periodParam: "week",
      now: new Date("2026-05-08T12:00:00Z"),
    });

    expect(todayView.subtitle).toBe("Open-stage deals for Today.");
    expect(todayView.listBaseFilters).toMatchObject({
      updatedFrom: "2026-05-08",
      updatedTo: "2026-05-08",
    });
    expect(weekView.subtitle).toBe("Open-stage deals for Week.");
    expect(weekView.listBaseFilters).toMatchObject({
      updatedFrom: "2026-05-04",
      updatedTo: "2026-05-08",
    });
  });

  it("accepts active_pipeline dashboard aliases for active-pipeline drill-downs", () => {
    const view = getDashboardDealListView({
      filterParam: "active_pipeline",
      periodParam: "qtd",
      now: new Date("2026-05-08T12:00:00Z"),
    });

    expect(view.filter).toBe("active_pipeline");
    expect(view.title).toBe("Active Pipeline");
    expect(view.boardMode).toBe("active");
  });

  it("builds stale and at-risk drill-down views from dashboard query params", () => {
    const staleView = getDashboardDealListView({
      filterParam: "stale",
      periodParam: "qtd",
      now: new Date("2026-05-08T12:00:00Z"),
    });
    const riskView = getDashboardDealListView({
      filterParam: "at_risk",
      periodParam: "qtd",
      now: new Date("2026-05-08T12:00:00Z"),
    });

    expect(staleView.title).toBe("Stale Deals");
    expect(staleView.boardMode).toBe("at_risk");
    expect(staleView.listInitialSort).toEqual({ key: "stage_entered_at", dir: "asc" });
    expect(staleView.showEmbeddedList).toBe(true);
    expect(riskView.title).toBe("Deals At Risk");
    expect(riskView.boardMode).toBe("at_risk");
    expect(riskView.showEmbeddedList).toBe(true);
  });

  it("builds stage-specific rep funnel drill-down views", () => {
    const opportunitiesView = getDashboardDealListView({
      filterParam: "opportunities",
      periodParam: "qtd",
      now: new Date("2026-05-08T12:00:00Z"),
    });
    const bidBoardView = getDashboardDealListView({
      filterParam: "bid_board",
      periodParam: "qtd",
      now: new Date("2026-05-08T12:00:00Z"),
    });

    expect(opportunitiesView.title).toBe("Opportunities");
    expect(opportunitiesView.initialStageSlugs).toEqual(["opportunity"]);
    expect(opportunitiesView.boardStageSlugs).toEqual(["opportunity"]);
    expect(bidBoardView.title).toBe("Bid Board");
    expect(bidBoardView.initialStageSlugs).toEqual(["estimating", "service_estimating"]);
    expect(bidBoardView.boardStageSlugs).toEqual(["estimating", "service_estimating"]);
  });

  it("builds the closed won drill-down view with contract-signed date filters", () => {
    const view = getDashboardDealListView({
      filterParam: "won",
      periodParam: "qtd",
      now: new Date("2026-05-08T12:00:00Z"),
    });

    expect(view.filter).toBe("won");
    expect(view.title).toBe("Closed Won");
    expect(view.boardMode).toBe("won");
    expect(view.listBaseFilters).toMatchObject({
      contractSignedFrom: "2026-04-01",
      contractSignedTo: "2026-05-08",
    });
    expect(view.listInitialSort).toEqual({ key: "contract_signed_date", dir: "desc" });
  });

  it("formats dashboard drill-down dates in local calendar time instead of UTC truncation", () => {
    const fakeLocalDate = {
      getFullYear: () => 2026,
      getMonth: () => 4,
      getDate: () => 15,
      toISOString: () => "2026-05-16T02:00:00.000Z",
    } as unknown as Date;

    expect(formatDateInput(fakeLocalDate)).toBe("2026-05-15");
  });

  it("passes dashboard active-pipeline drill-down props into the embedded deals list", () => {
    renderPage("/deals?scope=team&filter=active_pipeline&period=ytd", "director");

    expect(mocks.dealsListSectionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Active Pipeline",
        eyebrow: "Director drill-down",
        enableExport: true,
        scope: "team",
        initialSort: { key: "updated_at", dir: "desc" },
        baseFilters: expect.objectContaining({
          updatedFrom: "2026-01-01",
          updatedTo: "2026-05-08",
        }),
      })
    );
  });

  it("treats period as a separate query param in active-pipeline drill-down urls", () => {
    renderPage("/deals?scope=team&filter=active_pipeline&period=ytd", "director");

    expect(mocks.dealsListSectionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Active Pipeline",
        baseFilters: expect.objectContaining({
          updatedFrom: "2026-01-01",
          updatedTo: "2026-05-08",
        }),
      })
    );
  });

  it("passes dashboard closed-won drill-down props into the embedded deals list", () => {
    renderPage("/deals?scope=all&filter=won&period=qtd", "admin");

    expect(mocks.dealsListSectionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Closed Won",
        scope: "all",
        initialSort: { key: "contract_signed_date", dir: "desc" },
        baseFilters: expect.objectContaining({
          contractSignedFrom: "2026-04-01",
          contractSignedTo: "2026-05-08",
        }),
      })
    );
  });

  it("filters stale kanban drill-down cards to the selected dashboard period", () => {
    mocks.useDealBoardMock.mockReturnValue({
      board: {
        columns: [
          {
            stage: { id: "stage-contract", name: "Contract", slug: "contract" },
            count: 2,
            totalValue: 300000,
            cards: [
              makeDeal({
                id: "deal-in-period",
                name: "QTD Stale Deal",
                stageId: "stage-contract",
                stageEnteredAt: "2026-04-02T10:00:00.000Z",
                updatedAt: "2026-05-01T10:00:00.000Z",
                bidEstimate: "200000",
              }),
              makeDeal({
                id: "deal-old-period",
                name: "Old Quarter Stale Deal",
                stageId: "stage-contract",
                stageEnteredAt: "2026-03-01T10:00:00.000Z",
                updatedAt: "2026-03-15T10:00:00.000Z",
                bidEstimate: "100000",
              }),
              makeDeal({
                id: "deal-fresh",
                name: "Fresh QTD Deal",
                stageId: "stage-contract",
                stageEnteredAt: "2026-05-06T10:00:00.000Z",
                updatedAt: "2026-05-07T10:00:00.000Z",
                bidEstimate: "150000",
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

    const html = renderPage("/deals?scope=team&filter=stale&period=qtd", "director");

    expect(html).toContain("QTD Stale Deal");
    expect(html).not.toContain("Old Quarter Stale Deal");
    expect(html).not.toContain("Fresh QTD Deal");
  });

  it("keeps the embedded list visible for stale drill-down views", () => {
    const html = renderPage("/deals?scope=team&filter=stale&period=qtd", "director");

    expect(mocks.dealsListSectionMock).not.toHaveBeenCalled();
    expect(html).toContain("Drill-down view: SLA filter applied to list and board.");
    expect(html).toContain("Filtered results");
    expect(html).not.toContain("The filtered board above is the source of truth");
  });

  it("reflects the team scope query param in the scope toggle", () => {
    const html = renderPage("/deals?scope=team", "director");

    expect(mocks.useDealBoardMock).toHaveBeenLastCalledWith("team", true, expect.any(Object));
    expect(html).toContain('aria-pressed="true">Team');
    expect(html).toContain('aria-pressed="false">Mine');
    expect(html).toContain('aria-pressed="false">All');
  });

  it("adds terminal date filter controls to Won and Lost on /deals", () => {
    const html = renderPage("/deals?scope=all&won_preset=30&lost_preset=60");

    expect(html).not.toContain("Coverage map");
    expect(html).not.toContain("DFW map");
    expect(html).toContain("Won<span class=\"ml-1 text-slate-400\">· Last 30d");
    expect(html).toContain("Lost<span class=\"ml-1 text-slate-400\">· Last 60d");
    expect(html).toContain("Last 30d");
    expect(html).toContain("Last 60d");
  });

  it("shows a selected-range empty state for empty terminal columns", () => {
    mocks.useDealBoardMock.mockReturnValue({
      board: { columns: [], terminalStages: [] },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = renderPage("/deals?scope=all&won_preset=30&lost_preset=60");

    expect(html).toContain("No deals in selected range");
  });
});
