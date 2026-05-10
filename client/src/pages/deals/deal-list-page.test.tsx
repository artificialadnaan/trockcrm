// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { DealListPage, buildDealStageNavigationPath } from "./deal-list-page";

const mocks = vi.hoisted(() => ({
  useDealBoardMock: vi.fn(),
  useDealsMock: vi.fn(),
  usePipelineStagesMock: vi.fn(),
  readTerminalDateFilterMock: vi.fn(),
  buildDealStageWorkspacePathMock: vi.fn(),
  useAuthMock: vi.fn(),
}));

vi.mock("@/hooks/use-deals", () => ({
  useDealBoard: mocks.useDealBoardMock,
  useDeals: mocks.useDealsMock,
}));

vi.mock("@/hooks/use-pipeline-config", () => ({
  usePipelineStages: mocks.usePipelineStagesMock,
}));

vi.mock("@/lib/auth", () => ({
  useAuth: mocks.useAuthMock,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, className }: { children: ReactNode; className?: string }) => (
    <button className={className}>{children}</button>
  ),
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
    mocks.useDealBoardMock.mockReset();
    mocks.useDealsMock.mockReset();
    mocks.usePipelineStagesMock.mockReset();
    mocks.readTerminalDateFilterMock.mockReset();
    mocks.buildDealStageWorkspacePathMock.mockReset();
    mocks.useAuthMock.mockReset();

    mocks.readTerminalDateFilterMock.mockImplementation((outcome: string) => ({
      preset: outcome === "won" ? "30" : "60",
    }));
    mocks.buildDealStageWorkspacePathMock.mockReturnValue("/deals/stages/stage-won?scope=all");

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
      pagination: { page: 1, limit: 50, total: 2, totalPages: 1 },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
  });

  it("renders a readonly deal board with canonical stage labels", () => {
    const html = renderPage();

    expect(mocks.useDealBoardMock).toHaveBeenCalledWith("all", true, {
      won: { preset: "custom", customStart: "2026-01-01" },
      lost: { preset: "custom", customStart: "2026-01-01" },
    });
    expect(html).toContain("Read-only pipeline board");
    expect(html).toContain("Opportunity");
    expect(html).toContain("Estimating");
    expect(html).toContain("Service Estimating");
    expect(html).toContain("Estimate Sent to Client");
    expect(html).toContain("Palm Villas");
    expect(html).toContain("Service Hospital Roof");
  });

  it("renders company name on deal cards instead of UUID", () => {
    const companyId = "a3f8c2d1-1111-4444-9999-abcdefabcdef";
    mocks.useDealBoardMock.mockReturnValue({
      board: {
        columns: [
          {
            stage: { id: "stage-opportunity", name: "Opportunity", slug: "opportunity" },
            count: 1,
            totalValue: 180000,
            cards: [makeDeal({ companyId, companyName: "Acme Construction" })],
          },
        ],
        terminalStages: [],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = renderPage();

    expect(html).toContain("Acme Construction");
    expect(html).not.toContain(companyId);
  });

  it("shows Account pending when company name is missing", () => {
    mocks.useDealBoardMock.mockReturnValue({
      board: {
        columns: [
          {
            stage: { id: "stage-opportunity", name: "Opportunity", slug: "opportunity" },
            count: 1,
            totalValue: 180000,
            cards: [makeDeal({ companyId: "company-1", companyName: null })],
          },
        ],
        terminalStages: [],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = renderPage();

    expect(html).toContain("Account pending");
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
    expect(html).toContain("No deals in this stage.");
  });

  it("reads terminal date filters at interaction time when opening terminal stages", () => {
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

    expect(mocks.buildDealStageWorkspacePathMock).toHaveBeenLastCalledWith({
      stageId: "stage-won",
      stageSlug: "won",
      scope: "all",
      filters: {
        won: { preset: "30" },
        lost: { preset: "60" },
      },
    });

    mocks.readTerminalDateFilterMock.mockImplementation((outcome: string) => ({
      preset: outcome === "won" ? "7" : "30",
    }));

    buildDealStageNavigationPath(column, "all");

    expect(mocks.buildDealStageWorkspacePathMock).toHaveBeenLastCalledWith({
      stageId: "stage-won",
      stageSlug: "won",
      scope: "all",
      filters: {
        won: { preset: "7" },
        lost: { preset: "30" },
      },
    });
  });

  it("requests year-to-date terminal totals for the Won YTD metric", () => {
    renderPage();

    expect(mocks.useDealBoardMock).toHaveBeenCalledWith("all", true, {
      won: { preset: "custom", customStart: "2026-01-01" },
      lost: { preset: "custom", customStart: "2026-01-01" },
    });
  });

  it("recomputes YTD filters when calendar year changes", () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-12-31T18:00:00.000Z"));
    mocks.useDealBoardMock.mockClear();
    mocks.useAuthMock.mockReturnValue({
      user: {
        id: "user-1",
        email: "admin@example.test",
        displayName: "Test User",
        role: "admin",
        officeId: "office-1",
        activeOfficeId: "office-1",
      },
      loading: false,
    });
    mocks.usePipelineStagesMock.mockReturnValue({
      stages: [
        { id: "stage-opportunity", name: "Opportunity", slug: "opportunity", displayOrder: 1 },
      ],
    });
    mocks.useDealBoardMock.mockReturnValue({
      board: {
        columns: [],
        terminalStages: [],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    let root: Root | null = null;

    try {
      act(() => {
        root = createRoot(container);
        root.render(
          <MemoryRouter initialEntries={["/deals?scope=all"]}>
            <DealListPage />
          </MemoryRouter>
        );
      });

      expect(mocks.useDealBoardMock).toHaveBeenLastCalledWith("all", true, {
        won: { preset: "custom", customStart: "2026-01-01" },
        lost: { preset: "custom", customStart: "2026-01-01" },
      });

      vi.setSystemTime(new Date("2027-01-02T18:00:00.000Z"));
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });

      expect(mocks.useDealBoardMock).toHaveBeenLastCalledWith("all", true, {
        won: { preset: "custom", customStart: "2027-01-01" },
        lost: { preset: "custom", customStart: "2027-01-01" },
      });
    } finally {
      act(() => root?.unmount());
      container.remove();
      vi.useRealTimers();
    }
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

  it("uses the board's YTD terminal filters when building terminal stage navigation", () => {
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

  it("loads recent deal movement with the active scope", () => {
    renderPage("/deals?scope=team", "director");
    expect(mocks.useDealsMock).toHaveBeenLastCalledWith({
      limit: 200,
      isActive: true,
      sortBy: "updated_at",
      sortDir: "desc",
      scope: "team",
    });

    renderPage("/deals?scope=all", "admin");
    expect(mocks.useDealsMock).toHaveBeenLastCalledWith({
      limit: 200,
      isActive: true,
      sortBy: "updated_at",
      sortDir: "desc",
      scope: "all",
    });
  });

  it("renders the WORKFLOW CONTROL eyebrow with DEALS title and three KPI cards", () => {
    const html = renderPage();

    expect(html).toContain("Workflow control");
    expect(html).toContain(">Deals<");
    expect(html).toContain("Active pipeline");
    expect(html).toContain("Won YTD");
    expect(html).toContain("At risk");
  });

  it("caps each kanban column height so internal scroll engages instead of page scroll", () => {
    const html = renderPage();

    expect(html).toContain("max-h-[44rem]");
    expect(html).toContain("overflow-y-auto");
  });

  it("honors ?scope=team query param by passing it through to useDealBoard", () => {
    renderPage("/deals?scope=team", "director");

    expect(mocks.useDealBoardMock).toHaveBeenCalledWith("team", true, expect.any(Object));
  });

  it("renders visibility badge using pagination total when available", () => {
    mocks.useDealsMock.mockReturnValue({
      deals: Array.from({ length: 200 }, (_, index) =>
        makeDeal({ id: `deal-${index}`, name: `Deal ${index}` })
      ),
      pagination: { page: 1, limit: 200, total: 472, totalPages: 3 },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = renderPage("/deals?scope=all", "admin");

    expect(html).toContain("472 visible");
    expect(html).not.toContain("200 visible");
  });
});
