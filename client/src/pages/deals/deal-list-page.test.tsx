// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { act, useEffect } from "react";
import type { Deal } from "@/hooks/use-deals";
import type { AtRiskResult } from "@trock-crm/shared/types";
import {
  DealListPage,
  buildDealsPageKpiDrilldownPath,
  buildDealStageNavigationPath,
  formatDateInput,
  getCanonicalTerminalMetric,
  getDashboardDealListView,
  matchesUpdatedRange,
  resolveDrilldownTerminalDateFilters,
  sumNonOnHoldDealValues,
} from "./deal-list-page";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NativeDate = globalThis.Date;

async function withMockedTimezoneOffset<T>(offsetMinutes: number, run: () => T | Promise<T>) {
  const fakeNow = Date.now();
  vi.useRealTimers();

  const offsetMs = offsetMinutes * 60_000;

  class MockDate extends NativeDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super();
        return;
      }

      if (args.length > 1) {
        const [year, month, day = 1, hours = 0, minutes = 0, seconds = 0, ms = 0] =
          args as unknown as [number, number, number?, number?, number?, number?, number?];
        super(NativeDate.UTC(year, month, day, hours, minutes, seconds, ms) + offsetMs);
        return;
      }

      super(args[0] as string | number | Date);
    }

    static UTC = NativeDate.UTC.bind(NativeDate);
    static parse = NativeDate.parse.bind(NativeDate);
    static now = NativeDate.now.bind(NativeDate);

    getTimezoneOffset() {
      return offsetMinutes;
    }

    getFullYear() {
      return new NativeDate(super.getTime() - offsetMs).getUTCFullYear();
    }

    getMonth() {
      return new NativeDate(super.getTime() - offsetMs).getUTCMonth();
    }

    getDate() {
      return new NativeDate(super.getTime() - offsetMs).getUTCDate();
    }

    getDay() {
      return new NativeDate(super.getTime() - offsetMs).getUTCDay();
    }

    setDate(date: number) {
      const shifted = new NativeDate(super.getTime() - offsetMs);
      shifted.setUTCDate(date);
      return super.setTime(shifted.getTime() + offsetMs);
    }

    setHours(hours: number, minutes = 0, seconds = 0, ms = 0) {
      const shifted = new NativeDate(super.getTime() - offsetMs);
      shifted.setUTCHours(hours, minutes, seconds, ms);
      return super.setTime(shifted.getTime() + offsetMs);
    }
  }

  globalThis.Date = MockDate as unknown as DateConstructor;
  try {
    return await run();
  } finally {
    globalThis.Date = NativeDate;
    vi.useFakeTimers();
    vi.setSystemTime(fakeNow);
  }
}

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
  useRegions: () => ({ regions: [{ id: "region-1", name: "DFW" }] }),
  useProjectTypes: () => ({ projectTypes: [{ id: "type-1", name: "Multifamily" }] }),
}));

vi.mock("@/hooks/use-task-assignees", () => ({
  useTaskAssignees: mocks.useTaskAssigneesMock,
}));

vi.mock("@/lib/auth", () => ({
  useAuth: mocks.useAuthMock,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, className, ...props }: { children: ReactNode; className?: string } & ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button className={className} {...props}>{children}</button>
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

function changeInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function lastSearch(searches: string[]) {
  return searches[searches.length - 1];
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
  } as Deal;
}

function makeAtRiskResult(overrides: Partial<AtRiskResult> = {}): AtRiskResult {
  return {
    isAtRisk: true,
    status: "at_risk",
    severity: "at_risk",
    reason: "threshold_reached",
    stageSlug: "contract",
    canonicalStageSlug: "contract",
    viewerRole: "rep",
    audience: "rep",
    policy: {
      audience: "rep",
      stageSlug: "contract",
      dayCounting: "calendar_days",
      thresholdDays: 7,
      recurs: false,
      recurrenceDays: null,
    },
    effectiveStageAgeSeconds: 8 * 86_400,
    effectiveStageAgeDays: 8,
    thresholdSeconds: 7 * 86_400,
    thresholdDays: 7,
    secondsUntilThreshold: 0,
    secondsPastThreshold: 86_400,
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

async function renderPageDom(path = "/deals?scope=all", role = "admin") {
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

  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;

  await act(async () => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <DealListPage />
      </MemoryRouter>
    );
  });

  return {
    container,
    rerender: async (nextPath = path, nextRole = role) => {
      mocks.useAuthMock.mockReturnValue({
        user: {
          id: "user-1",
          email: `${nextRole}@example.test`,
          displayName: "Test User",
          role: nextRole,
          officeId: "office-1",
          activeOfficeId: "office-1",
        },
        loading: false,
      });

      await act(async () => {
        root?.render(
          <MemoryRouter initialEntries={[nextPath]}>
            <DealListPage />
          </MemoryRouter>
        );
      });
    },
    cleanup: async () => {
      await act(async () => {
        root?.unmount();
      });
      container.remove();
    },
  };
}

async function renderPageDomWithLocation(path = "/deals?scope=all", role = "admin") {
  const searches: string[] = [];

  function PageWithLocationProbe() {
    const location = useLocation();
    useEffect(() => {
      searches.push(location.search);
    }, [location.search]);
    return <DealListPage />;
  }

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

  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;

  await act(async () => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <PageWithLocationProbe />
      </MemoryRouter>
    );
  });

  return {
    container,
    searches,
    cleanup: async () => {
      await act(async () => {
        root?.unmount();
      });
      container.remove();
    },
  };
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
        { id: "stage-closed-won", name: "Closed Won", slug: "closed_won", displayOrder: 6 }, // a Won alias
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
    }, 8, null, undefined, {});
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

  it("layers the Deals page rep and Estimate Sent filters into the board and embedded list", () => {
    renderPage("/deals?scope=all&assignedRepId=rep-1&estimate_sent_since=2026-04-01&estimate_sent_until=2026-04-30&filter=bid_board");

    expect(mocks.useDealBoardMock).toHaveBeenCalledWith(
      "all",
      true,
      { won: { preset: "all" }, lost: { preset: "all" } },
      8,
      null,
      "rep-1",
      { from: "2026-04-01", to: "2026-04-30" }
    );
    expect(mocks.dealsListSectionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        lockedOwnerId: "rep-1",
        hideOwnerFilter: true,
        baseFilters: expect.objectContaining({
          estimateSentFrom: "2026-04-01",
          estimateSentTo: "2026-04-30",
        }),
        initialStageSlugs: ["estimating", "service_estimating"],
      })
    );
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
    expect(html).toMatch(/Active pipeline.*\$180K.*1\/1 deals/);
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

    expect(html).toMatch(/Active pipeline.*\$1\.6M.*152\/152 deals/);
    expect(html).not.toContain("101 deals");
  });

  it("renders the Won KPI from the canonical Won column and ignores duplicated terminal-stage aggregates", () => {
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
            count: 294,
            totalCount: 344,
            totalValue: 21690316.66,
            cards: [],
          },
        ],
        terminalStages: [
          {
            stage: { id: "stage-won", name: "Won", slug: "won" },
            count: 294,
            totalValue: 21690316.66,
          },
          {
            stage: { id: "stage-won-copy-1", name: "Won", slug: "won" },
            count: 294,
            totalValue: 21690316.66,
          },
          {
            stage: { id: "stage-won-copy-2", name: "Won", slug: "won" },
            count: 294,
            totalValue: 21690316.66,
          },
        ],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = renderPage();

    expect(html).toMatch(/Won.*\$21\.7M/);
    expect((html.match(/\$21\.7M/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(html).not.toContain("$65.1M");
  });

  it("maps Won and Lost summary metrics from canonical columns", () => {
    const metrics = [
      {
        stage: { id: "stage-won", name: "Won", slug: "won" },
        count: 294,
        totalCount: 344,
        totalValue: 21690316.66,
        cards: [],
      },
      {
        stage: { id: "stage-lost", name: "Lost", slug: "lost" },
        count: 12,
        totalCount: 17,
        totalValue: 430000,
        cards: [],
      },
    ];

    expect(getCanonicalTerminalMetric(metrics, "won")).toEqual({
      count: 294,
      totalCount: 344,
      totalValue: 21690316.66,
    });
    expect(getCanonicalTerminalMetric(metrics, "lost")).toEqual({
      count: 12,
      totalCount: 17,
      totalValue: 430000,
    });
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
    }, 8, null, undefined, {});
  });

  it("does not refetch or update URL params while editing a custom terminal date until Enter commits it", async () => {
    const view = await renderPageDomWithLocation("/deals?scope=all&won_since=2026-04-01");
    const initialBoardCalls = mocks.useDealBoardMock.mock.calls.length;

    await act(async () => {
      view.container.querySelector<HTMLButtonElement>('button[aria-label="Won date filter"]')?.click();
    });

    const startInput = document.body.querySelector<HTMLInputElement>('input[aria-label="Won start date"]');
    expect(startInput?.value).toBe("2026-04-01");

    await act(async () => {
      if (!startInput) return;
      changeInputValue(startInput, "2026-04-15");
    });

    expect(mocks.useDealBoardMock.mock.calls).toHaveLength(initialBoardCalls);
    expect(lastSearch(view.searches)).toBe("?scope=all&won_since=2026-04-01");

    await act(async () => {
      startInput?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    expect(mocks.useDealBoardMock.mock.calls.length).toBeGreaterThan(initialBoardCalls);
    expect(mocks.useDealBoardMock).toHaveBeenLastCalledWith(
      "all",
      true,
      {
        won: { preset: "custom", customStart: "2026-04-15" },
        lost: { preset: "all" },
      },
      8,
      null,
      undefined,
      {}
    );
    expect(lastSearch(view.searches)).toContain("won_since=2026-04-15");

    await view.cleanup();
  });

  it("does not refetch or update URL params while editing a custom lost date until Apply commits it", async () => {
    const view = await renderPageDomWithLocation("/deals?scope=all&lost_since=2026-03-01");
    const initialBoardCalls = mocks.useDealBoardMock.mock.calls.length;

    await act(async () => {
      view.container.querySelector<HTMLButtonElement>('button[aria-label="Lost date filter"]')?.click();
    });

    const startInput = document.body.querySelector<HTMLInputElement>('input[aria-label="Lost start date"]');
    expect(startInput?.value).toBe("2026-03-01");

    await act(async () => {
      if (!startInput) return;
      changeInputValue(startInput, "2026-03-12");
    });

    expect(mocks.useDealBoardMock.mock.calls).toHaveLength(initialBoardCalls);
    expect(lastSearch(view.searches)).toBe("?scope=all&lost_since=2026-03-01");

    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('button[aria-label="Apply Lost custom date range"]')?.click();
    });

    expect(mocks.useDealBoardMock.mock.calls.length).toBeGreaterThan(initialBoardCalls);
    expect(mocks.useDealBoardMock).toHaveBeenLastCalledWith(
      "all",
      true,
      {
        won: { preset: "all" },
        lost: { preset: "custom", customStart: "2026-03-12" },
      },
      8,
      null,
      undefined,
      {}
    );
    expect(lastSearch(view.searches)).toContain("lost_since=2026-03-12");

    await view.cleanup();
  });

  it("commits a terminal preset immediately to URL params and the board request", async () => {
    const view = await renderPageDomWithLocation("/deals?scope=all&won_since=2026-04-01");
    const initialBoardCalls = mocks.useDealBoardMock.mock.calls.length;

    await act(async () => {
      view.container.querySelector<HTMLButtonElement>('button[aria-label="Won date filter"]')?.click();
    });

    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('button[aria-label="Show Won deals from the last 7 days"]')?.click();
    });

    expect(mocks.useDealBoardMock.mock.calls.length).toBeGreaterThan(initialBoardCalls);
    expect(mocks.useDealBoardMock).toHaveBeenLastCalledWith(
      "all",
      true,
      {
        won: { preset: "7" },
        lost: { preset: "all" },
      },
      8,
      null,
      undefined,
      {}
    );
    expect(lastSearch(view.searches)).toContain("won_preset=7");
    expect(lastSearch(view.searches)).not.toContain("won_since=2026-04-01");

    await view.cleanup();
  });

  it("does not refetch the board while editing the Estimate Sent date filter until Apply commits it", async () => {
    const view = await renderPageDomWithLocation("/deals?scope=all&estimate_sent_since=2026-04-01");
    const initialBoardCalls = mocks.useDealBoardMock.mock.calls.length;

    await act(async () => {
      view.container.querySelector<HTMLButtonElement>('button[aria-label="Estimate Sent to Client date filter"]')?.click();
    });

    const startInput = document.body.querySelector<HTMLInputElement>(
      'input[aria-label="Estimate Sent to Client start date"]'
    );
    expect(startInput?.value).toBe("2026-04-01");

    await act(async () => {
      if (!startInput) return;
      changeInputValue(startInput, "2026-04-16");
    });

    expect(mocks.useDealBoardMock.mock.calls).toHaveLength(initialBoardCalls);
    expect(lastSearch(view.searches)).toBe("?scope=all&estimate_sent_since=2026-04-01");

    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('button[aria-label="Apply Estimate Sent to Client custom date range"]')
        ?.click();
    });

    expect(mocks.useDealBoardMock.mock.calls.length).toBeGreaterThan(initialBoardCalls);
    expect(mocks.useDealBoardMock).toHaveBeenLastCalledWith(
      "all",
      true,
      {
        won: { preset: "all" },
        lost: { preset: "all" },
      },
      8,
      null,
      undefined,
      { from: "2026-04-16" }
    );
    expect(lastSearch(view.searches)).toContain("estimate_sent_since=2026-04-16");

    await view.cleanup();
  });

  it("requests an expanded preview window for the SLA drill-down board", () => {
    renderPage("/deals?scope=all&filter=at_risk&period=week", "director");

    expect(mocks.useDealBoardMock).toHaveBeenCalledWith("all", true, {
      won: { preset: "all" },
      lost: { preset: "all" },
    }, 1000, { from: "2026-05-03", to: "2026-05-08" }, undefined, {});
  });

  it("passes the selected page period to the board request so won aggregates match the drilldown window", () => {
    renderPage("/deals?scope=all&period=last_month&won_preset=30", "director");

    expect(mocks.useDealBoardMock).toHaveBeenCalledWith("all", true, {
      won: { preset: "30" },
      lost: { preset: "all" },
    }, 8, { from: "2026-04-01", to: "2026-04-30" }, undefined, {});
  });

  describe("D-7: Won drill-down chip inherits the page period (no contradictory all_time+period)", () => {
    it("seeds the Won terminal filter from the inherited period when the URL has no explicit Won filter", () => {
      const resolved = resolveDrilldownTerminalDateFilters(
        new URLSearchParams("filter=won&period=qtd&scope=all"),
        new Date("2026-05-31T12:00:00.000Z")
      );
      expect(resolved.won).toEqual({ preset: "qtd" });
      expect(resolved.lost).toEqual({ preset: "all" });
    });

    it("respects an explicit Won filter in the URL over the period (the user's choice wins)", () => {
      expect(
        resolveDrilldownTerminalDateFilters(new URLSearchParams("filter=won&period=qtd&won_preset=30&scope=all")).won
      ).toEqual({ preset: "30" });
      expect(
        resolveDrilldownTerminalDateFilters(new URLSearchParams("filter=won&period=qtd&won_all_time=true&scope=all")).won
      ).toEqual({ preset: "all" });
    });

    it("maps last_* periods to a custom window so the chip never reads the false 'All time'", () => {
      const won = resolveDrilldownTerminalDateFilters(
        new URLSearchParams("filter=won&period=last_quarter&scope=all"),
        new Date("2026-05-31T12:00:00.000Z")
      ).won;
      expect(won.preset).toBe("custom");
    });

    it("does NOT route period=today through a custom window (Codex #566: a to-date customEnd=today gets UTC-clamped, contradicting the local won_period and emptying the board)", () => {
      const won = resolveDrilldownTerminalDateFilters(
        new URLSearchParams("filter=won&period=today&scope=all"),
        new Date("2026-05-31T12:00:00.000Z")
      ).won;
      expect(won).toEqual({ preset: "all" });
    });

    it("leaves the Won filter at its default when no period is inherited", () => {
      expect(resolveDrilldownTerminalDateFilters(new URLSearchParams("scope=all")).won).toEqual({ preset: "all" });
    });

    it("sends the period-derived Won terminal filter to the board request (won_since/until via the preset, never won_all_time)", () => {
      renderPage("/deals?filter=won&period=qtd&scope=all", "director");
      const lastCall = mocks.useDealBoardMock.mock.calls[mocks.useDealBoardMock.mock.calls.length - 1];
      // arg[2] is terminalDateFilters -> the Won column chip reads "QTD", and
      // appendPipelineTerminalDateParams emits won_since/until for a preset (not won_all_time).
      expect(lastCall[2].won).toEqual({ preset: "qtd" });
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

    expect(mocks.useDealBoardMock).toHaveBeenCalledWith("mine", true, expect.any(Object), 8, null, undefined, {});
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

  it("preserves rep and Estimate Sent filters when opening a stage", () => {
    const column = {
      stage: { id: "stage-sent", name: "Estimate Sent to Client", slug: "estimate_sent_to_client" },
      count: 0,
      totalValue: 0,
      cards: [],
    };

    buildDealStageNavigationPath(
      column,
      "all",
      { won: { preset: "all" }, lost: { preset: "all" } },
      new URLSearchParams("assignedRepId=rep-1&estimate_sent_since=2026-04-01&estimate_sent_until=2026-04-30&search=roof")
    );

    expect(mocks.buildDealStageWorkspacePathMock).toHaveBeenLastCalledWith({
      stageId: "stage-sent",
      stageSlug: "estimate_sent_to_client",
      scope: "all",
      filters: { won: { preset: "all" }, lost: { preset: "all" } },
      queryParams: expect.any(URLSearchParams),
    });
  });

  it("defaults the board scope by role when the query param is absent", () => {
    renderPage("/deals", "rep");
    expect(mocks.useDealBoardMock).toHaveBeenLastCalledWith("mine", true, expect.any(Object), 8, null, undefined, {});

    renderPage("/deals", "director");
    expect(mocks.useDealBoardMock).toHaveBeenLastCalledWith("mine", true, expect.any(Object), 8, null, undefined, {});

    renderPage("/deals", "admin");
    expect(mocks.useDealBoardMock).toHaveBeenLastCalledWith("mine", true, expect.any(Object), 8, null, undefined, {});

    renderPage("/deals?scope=mine", "director");
    expect(mocks.useDealBoardMock).toHaveBeenLastCalledWith("mine", true, expect.any(Object), 8, null, undefined, {});
  });

  it("hides the Team scope and coerces a requested team scope to mine (D-12b)", () => {
    const html = renderPage("/deals?scope=team", "rep");

    // Team is no longer offered and never reaches the board hook: ?scope=team is
    // coerced to the rendered fallback ("mine"); no dead placeholder is shown.
    expect(html).not.toContain(">Team</button>");
    expect(html).not.toContain("Team view is not yet configured");
    expect(mocks.useDealBoardMock).toHaveBeenLastCalledWith("mine", true, expect.any(Object), 8, null, undefined, {});
  });

  it("drops a stale owner filter when a team bookmark is coerced to mine (D-12b)", () => {
    renderPage("/deals?scope=team&assignedRepId=rep-2", "director");

    // Coerced to mine AND the owner filter cleared (6th arg undefined), so the Mine board is
    // not intersected with rep-2's deals into an empty result.
    expect(mocks.useDealBoardMock).toHaveBeenLastCalledWith("mine", true, expect.any(Object), 8, null, undefined, {});
  });

  it("rewrites a parked team bookmark URL to mine and drops the stale owner param (D-12b)", async () => {
    const { searches, cleanup } = await renderPageDomWithLocation(
      "/deals?scope=team&assignedRepId=rep-2",
      "director"
    );

    try {
      // The cleanup effect rewrites the URL so the stale scope/owner params do not persist and
      // re-apply when the user later switches scope.
      const finalParams = new URLSearchParams(searches[searches.length - 1] ?? "");
      expect(finalParams.get("scope")).toBe("mine");
      expect(finalParams.get("assignedRepId")).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("allows reps to opt into all-office scope", () => {
    const html = renderPage("/deals?scope=all", "rep");

    expect(mocks.useDealBoardMock).toHaveBeenLastCalledWith("all", true, expect.any(Object), 8, null, undefined, {});
    expect(html).toContain('aria-pressed="false">Mine');
    expect(html).toContain('aria-pressed="true">All');
    // Team is not an offered scope (D-12b).
    expect(html).not.toContain(">Team</button>");
  });
  it("embeds a scoped paginated exportable deal list below the kanban without date filters", () => {
    renderPage("/deals?scope=mine", "director");

    expect(mocks.dealsListSectionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowFamily: "deal",
        scope: "mine",
        enableExport: true,
        enableDateFilter: false,
        showFilterButton: true,
        pageSize: 20,
        searchPlaceholder: "Search deals or accounts",
      })
    );
  });

  it("builds clickable KPI drilldown paths with preserved scope and period", () => {
    expect(buildDealsPageKpiDrilldownPath("active_pipeline", "all")).toBe(
      "/deals?filter=active_pipeline&scope=all"
    );
    expect(buildDealsPageKpiDrilldownPath("won", "team", "last_month")).toBe(
      "/deals?filter=won&scope=team&period=last_month"
    );
    expect(
      buildDealsPageKpiDrilldownPath("won", "team", "last_month", {
        wonQueryParams: new URLSearchParams("won_preset=30&won_since=2026-04-01&won_until=2026-04-30"),
      })
    ).toBe("/deals?filter=won&scope=team&period=last_month&won_preset=30&won_since=2026-04-01&won_until=2026-04-30");
    expect(
      buildDealsPageKpiDrilldownPath("active_pipeline", "all", null, {
        queryParams: new URLSearchParams("assignedRepId=rep-1&estimate_sent_since=2026-04-01&estimate_sent_until=2026-04-30&search=roof"),
      })
    ).toBe("/deals?filter=active_pipeline&scope=all&assignedRepId=rep-1&estimate_sent_since=2026-04-01&estimate_sent_until=2026-04-30");
    expect(buildDealsPageKpiDrilldownPath("at_risk", "mine")).toBe(
      "/deals?filter=at_risk&scope=mine"
    );
  });

  it("renders clickable KPI cards on the deals page", () => {
    const html = renderPage("/deals?scope=all&period=last_month&assignedRepId=rep-1&estimate_sent_since=2026-04-01", "director");

    expect(html).toContain('href="/deals?filter=active_pipeline&amp;scope=all&amp;assignedRepId=rep-1&amp;estimate_sent_since=2026-04-01"');
    expect(html).toContain('href="/deals?filter=won&amp;scope=all&amp;period=last_month&amp;assignedRepId=rep-1&amp;estimate_sent_since=2026-04-01"');
    expect(html).toContain('href="/deals?filter=at_risk&amp;scope=all&amp;assignedRepId=rep-1&amp;estimate_sent_since=2026-04-01"');
    expect(html).toContain("View active pipeline deals");
    expect(html).toContain("View won deals");
    expect(html).toContain("View at-risk deals");
  });

  it("suppresses the Won KPI card on the at-risk drill-down (D-14: no swinging lifetime Won total beside at-risk deals)", () => {
    const html = renderPage("/deals?scope=all&filter=at_risk", "director");
    // The Won sibling card (and its unlabeled lifetime total) is gone on a
    // current-state drill-down; the relevant KPI cards remain.
    expect(html).not.toContain("View won deals");
    expect(html).toContain("View active pipeline deals");
    expect(html).toContain("View at-risk deals");
  });

  it("suppresses the Won KPI card on the active-pipeline drill-down", () => {
    expect(renderPage("/deals?scope=all&filter=active_pipeline", "director")).not.toContain("View won deals");
    expect(renderPage("/deals?scope=all&filter=active", "director")).not.toContain("View won deals");
  });

  it("keeps the Won KPI card on the Won drill-down and the base deals list (regression guard)", () => {
    expect(renderPage("/deals?scope=all&filter=won", "director")).toContain("View won deals");
    expect(renderPage("/deals?scope=all", "director")).toContain("View won deals");
  });

  it("preserves won terminal query params on the Won KPI drilldown link", () => {
    const html = renderPage("/deals?scope=all&period=last_month&won_preset=30&won_since=2026-04-01&won_until=2026-04-30", "director");

    expect(html).toContain(
      'href="/deals?filter=won&amp;scope=all&amp;period=last_month&amp;won_preset=30&amp;won_since=2026-04-01&amp;won_until=2026-04-30"'
    );
  });

  it("renders the Won KPI from the canonical backend column when the request preserves the page period", () => {
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
            stage: { id: "stage-won", name: "Won", slug: "won" },
            count: 2,
            totalValue: 125000,
            cards: [],
          },
        ],
        terminalStages: [
          {
            stage: { id: "stage-won", name: "Won", slug: "won" },
            count: 2,
            totalValue: 125000,
          },
        ],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = renderPage("/deals?scope=all&period=last_month", "director");

    expect(html).toContain('href="/deals?filter=won&amp;scope=all&amp;period=last_month"');
    expect(html).toContain("$125.0K");
    expect(html).not.toContain("$410K");
  });

  it("does not use aggregate-only terminal response shape for Won KPI rendering", () => {
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
            stage: { id: "stage-won", name: "Won", slug: "won" },
            count: 3,
            totalValue: 125000,
            cards: [],
          },
        ],
        terminalStages: [
          {
            stage: { id: "stage-won", name: "Won", slug: "won" },
            count: 3,
            totalValue: 375000,
          },
        ],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = renderPage("/deals?scope=all&period=last_month", "director");

    expect(html).toContain("$125.0K");
    expect(html).not.toContain("$375.0K");
    expect(html).not.toContain("$410K");
  });

  it("renders a single Won KPI value when the server emits duplicate Won-family pipelineColumns rows", () => {
    // Production server (getDealsForPipeline) emits one pipelineColumns row per
    // Won-family stage (won, closed_won, sent_to_production), each carrying the
    // SAME canonical aggregate. The client must NOT triple-count those rows
    // when computing the Won KPI value.
    const sharedCount = 294;
    const sharedTotal = 21690316.66;
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
            stage: { id: "stage-won-1", name: "Won", slug: "won" },
            count: sharedCount,
            totalValue: sharedTotal,
            cards: [],
          },
          {
            stage: { id: "stage-won-2", name: "Closed Won", slug: "closed_won" },
            count: sharedCount,
            totalValue: sharedTotal,
            cards: [],
          },
          {
            stage: { id: "stage-won-3", name: "Sent to Production", slug: "sent_to_production" },
            count: sharedCount,
            totalValue: sharedTotal,
            cards: [],
          },
        ],
        terminalStages: [],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = renderPage();

    // Single canonical Won aggregate ($21.7M compact-formatted), NOT $65.1M
    // (which would be the tripled value).
    expect(html).toMatch(/Won.*\$21\.7M/);
    expect(html).not.toContain("$65.1M");
  });

  it("passes the same effective won date range into the board request and drilldown list", () => {
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
            stage: { id: "stage-won", name: "Won", slug: "won" },
            count: 3,
            totalValue: 125000,
            cards: [],
          },
        ],
        terminalStages: [
          {
            stage: { id: "stage-won", name: "Won", slug: "won" },
            count: 3,
            totalValue: 125000,
          },
        ],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = renderPage("/deals?scope=all&filter=won&period=last_month&won_preset=30", "director");

    expect(html).toContain("$125.0K");
    expect(html).not.toContain("$410K");
    expect(html).not.toContain("$500K");
    expect(mocks.useDealBoardMock).toHaveBeenLastCalledWith(
      "all",
      true,
      {
        won: { preset: "30" },
        lost: { preset: "all" },
      },
      8,
      { from: "2026-04-01", to: "2026-04-30" },
      undefined,
      {}
    );
    expect(mocks.dealsListSectionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseFilters: expect.objectContaining({
          // Won drill-down now gates on the true HubSpot close-won date (§6.1),
          // not contract_signed (which is reserved for the commissions surface).
          wonClosedFrom: "2026-04-08",
          wonClosedTo: "2026-04-30",
        }),
      })
    );
  });

  it("mounts the shared FilterBar (fb_ namespace, outcome-aware, no rep dim) on a drill-down list", () => {
    renderPage("/deals?filter=won&scope=all", "director");
    const props = mocks.dealsListSectionMock.mock.calls[mocks.dealsListSectionMock.mock.calls.length - 1]?.[0] as {
      filterBar?: { paramPrefix?: string; stageEntryDateEnabled?: boolean; dimensions?: string[] };
    };
    expect(props.filterBar).toBeDefined();
    expect(props.filterBar?.paramPrefix).toBe("fb_");
    expect(props.filterBar?.stageEntryDateEnabled).toBe(true);
    // rep is the page-level select (drives board + list), not a bar dimension on the dashboard drill-downs
    expect(props.filterBar?.dimensions).not.toContain("rep");
  });

  it("leaves the base view (filter === null) WITHOUT a FilterBar — RED owns that mount", () => {
    renderPage("/deals?scope=all", "director");
    const props = mocks.dealsListSectionMock.mock.calls[mocks.dealsListSectionMock.mock.calls.length - 1]?.[0] as { filterBar?: unknown };
    expect(props.filterBar).toBeUndefined();
  });

  it("folds the selected rep into the drill-down list baseFilters (FilterBar mode ignores lockedOwnerId)", () => {
    renderPage("/deals?filter=won&scope=all&assignedRepId=rep-1", "director");
    const props = mocks.dealsListSectionMock.mock.calls[mocks.dealsListSectionMock.mock.calls.length - 1]?.[0] as { baseFilters?: { assignedRepId?: string } };
    expect(props.baseFilters?.assignedRepId).toBe("rep-1");
  });

  it("waits for stage metadata before mounting the drill-down bar — no all-deals flash (Codex P2)", () => {
    mocks.usePipelineStagesMock.mockReturnValue({ stages: [] }); // not loaded yet
    renderPage("/deals?filter=won&scope=all", "director");
    const props = mocks.dealsListSectionMock.mock.calls[mocks.dealsListSectionMock.mock.calls.length - 1]?.[0] as { filterBar?: unknown };
    expect(props.filterBar).toBeUndefined(); // legacy mode (which gates the query on stage loading) until stages arrive
  });

  it("carries the drill-down's intended default sort into the bar (Codex P2)", () => {
    renderPage("/deals?filter=won&scope=all", "director");
    const props = mocks.dealsListSectionMock.mock.calls[mocks.dealsListSectionMock.mock.calls.length - 1]?.[0] as {
      filterBar?: { defaultSort?: { key: string; dir: string } };
    };
    expect(props.filterBar?.defaultSort).toEqual({ key: "contract_signed_date", dir: "desc" }); // the Won view's order
  });

  it("RECONCILES the Won drill-down list to the KPI: full Won alias family + on-hold excluded (Codex P2)", () => {
    renderPage("/deals?filter=won&scope=all", "director");
    const props = mocks.dealsListSectionMock.mock.calls[mocks.dealsListSectionMock.mock.calls.length - 1]?.[0] as {
      filterBar?: { defaultStageIds?: string[]; terminalStageIds?: string[] };
      baseFilters?: { excludeOnHold?: boolean };
    };
    // The Won list scopes to the whole Won family (canonical + alias), matching the KPI / board column.
    expect(props.filterBar?.defaultStageIds).toContain("stage-won");
    expect(props.filterBar?.defaultStageIds).toContain("stage-closed-won"); // the alias — would be dropped if canonical-only
    // ...and excludes on-hold (migration parking-lot) deals, like the Won KPI.
    expect(props.baseFilters?.excludeOnHold).toBe(true);
  });

  it("uses the Won terminal filter caption ahead of the page period and falls back correctly", () => {
    const htmlWithTerminalFilter = renderPage("/deals?scope=all&period=last_month&won_preset=30", "director");
    const htmlWithPeriodOnly = renderPage("/deals?scope=all&period=last_month", "director");
    const htmlAllTime = renderPage("/deals?scope=all", "director");

    expect(htmlWithTerminalFilter).toContain("Last 30 days");
    expect(htmlWithPeriodOnly).toContain("Last month");
    expect(htmlAllTime).toContain("All time");
  });

  it("treats no-period won drill-downs as all-time instead of forcing a default dashboard range", () => {
    const view = getDashboardDealListView({
      filterParam: "won",
      periodParam: null,
      now: new Date("2026-05-08T12:00:00Z"),
    });

    expect(view.title).toBe("Closed Won");
    expect(view.subtitle).toBe("Booked wins across all time.");
    expect(view.listBaseFilters).toEqual({});
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
    // D-12: the active-pipeline list windows the CANONICAL outcome axis (dateFrom/dateTo
    // -> open rows bound by stage_entered_at), not updated_at, and sorts/displays that axis.
    expect(view.listBaseFilters).toMatchObject({
      dateFrom: "2026-01-01",
      dateTo: "2026-05-08",
    });
    expect(view.listBaseFilters).not.toHaveProperty("updatedFrom");
    expect(view.listInitialSort).toEqual({ key: "display_date", dir: "desc" });
    expect(view.listDateField).toBe("outcome");
  });

  it("supports today and week dashboard periods for rep drill-down links", () => {
    return withMockedTimezoneOffset(300, () => {
      const todayView = getDashboardDealListView({
        filterParam: "active_pipeline",
        periodParam: "today",
        now: new Date("2026-05-09T04:30:00.000Z"),
      });
      const weekView = getDashboardDealListView({
        filterParam: "active_pipeline",
        periodParam: "week",
        now: new Date("2026-05-11T04:30:00.000Z"),
      });

      expect(todayView.subtitle).toBe("Open-stage deals for Today.");
      expect(todayView.listBaseFilters).toMatchObject({
        dateFrom: "2026-05-08",
        dateTo: "2026-05-08",
      });
      expect(weekView.subtitle).toBe("Open-stage deals for Week.");
      expect(weekView.listBaseFilters).toMatchObject({
        dateFrom: "2026-05-10",
        dateTo: "2026-05-10",
      });
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

  it("builds the closed won drill-down view with hs-close-date period filters", () => {
    const view = getDashboardDealListView({
      filterParam: "won",
      periodParam: "qtd",
      now: new Date("2026-05-08T12:00:00Z"),
    });

    expect(view.filter).toBe("won");
    expect(view.title).toBe("Closed Won");
    expect(view.boardMode).toBe("won");
    // §6.1: the Won drill-down period is gated on the true HubSpot close-won date,
    // not contract_signed (reserved for the commissions surface, §6.5).
    expect(view.listBaseFilters).toMatchObject({
      wonClosedFrom: "2026-04-01",
      wonClosedTo: "2026-05-08",
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
    renderPage("/deals?scope=all&filter=active_pipeline&period=ytd", "director");

    expect(mocks.dealsListSectionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Active Pipeline",
        eyebrow: "Director drill-down",
        enableExport: true,
        scope: "all",
        // D-12: the embedded list filters + displays + sorts the outcome axis.
        dateField: "outcome",
        initialSort: { key: "display_date", dir: "desc" },
        baseFilters: expect.objectContaining({
          dateFrom: "2026-01-01",
          dateTo: "2026-05-08",
        }),
      })
    );
    // The active-pipeline drill-down surfaces the active/total count summary.
    expect(mocks.dealsListSectionMock.mock.calls[0]?.[0]).toHaveProperty("paginationCountSummary");
  });

  it("treats period as a separate query param in active-pipeline drill-down urls", () => {
    renderPage("/deals?scope=all&filter=active_pipeline&period=ytd", "director");

    expect(mocks.dealsListSectionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Active Pipeline",
        baseFilters: expect.objectContaining({
          dateFrom: "2026-01-01",
          dateTo: "2026-05-08",
        }),
      })
    );
  });

  it("uses local-day bounds for stale drill-down updated-date filtering west of UTC", () => {
    return withMockedTimezoneOffset(300, () => {
      const sameLocalDayDeal = makeDeal({ updatedAt: "2026-05-09T04:30:00.000Z" });
      const priorLocalDayDeal = makeDeal({ updatedAt: "2026-05-08T04:30:00.000Z" });

      expect(matchesUpdatedRange(sameLocalDayDeal, "2026-05-08", "2026-05-08")).toBe(true);
      expect(matchesUpdatedRange(priorLocalDayDeal, "2026-05-08", "2026-05-08")).toBe(false);
    });
  });

  it("uses local-day bounds for stale drill-down updated-date filtering east of UTC", () => {
    return withMockedTimezoneOffset(-300, () => {
      const sameLocalDayDeal = makeDeal({ updatedAt: "2026-05-07T19:30:00.000Z" });
      const nextLocalDayDeal = makeDeal({ updatedAt: "2026-05-08T19:30:00.000Z" });

      expect(matchesUpdatedRange(sameLocalDayDeal, "2026-05-08", "2026-05-08")).toBe(true);
      expect(matchesUpdatedRange(nextLocalDayDeal, "2026-05-08", "2026-05-08")).toBe(false);
    });
  });

  it("passes dashboard closed-won drill-down props into the embedded deals list", () => {
    renderPage("/deals?scope=all&filter=won&period=qtd", "admin");

    expect(mocks.dealsListSectionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Closed Won",
        scope: "all",
        initialSort: { key: "contract_signed_date", dir: "desc" },
        baseFilters: expect.objectContaining({
          wonClosedFrom: "2026-04-01",
          wonClosedTo: "2026-05-08",
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
            count: 4,
            totalValue: 430000,
            cards: [
              makeDeal({
                id: "deal-in-period",
                name: "QTD Stale Deal",
                stageId: "stage-contract",
                stageEnteredAt: "2026-04-02T10:00:00.000Z",
                updatedAt: "2026-05-01T10:00:00.000Z",
                bidEstimate: "200000",
                atRisk: makeAtRiskResult(),
              }),
              makeDeal({
                id: "deal-in-period-2",
                name: "Second QTD Stale Deal",
                stageId: "stage-contract",
                stageEnteredAt: "2026-04-04T10:00:00.000Z",
                updatedAt: "2026-04-22T10:00:00.000Z",
                bidEstimate: "130000",
                atRisk: makeAtRiskResult(),
              }),
              makeDeal({
                id: "deal-old-period",
                name: "Old Quarter Stale Deal",
                stageId: "stage-contract",
                stageEnteredAt: "2026-03-01T10:00:00.000Z",
                updatedAt: "2026-03-15T10:00:00.000Z",
                bidEstimate: "100000",
                atRisk: makeAtRiskResult(),
              }),
              makeDeal({
                id: "deal-fresh",
                name: "Fresh QTD Deal",
                stageId: "stage-contract",
                stageEnteredAt: "2026-05-06T10:00:00.000Z",
                updatedAt: "2026-05-07T10:00:00.000Z",
                bidEstimate: "150000",
                atRisk: makeAtRiskResult({
                  isAtRisk: false,
                  status: "not_at_risk",
                  severity: "none",
                  reason: "within_sla",
                }),
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

    const html = renderPage("/deals?scope=all&filter=stale&period=qtd", "director");

    expect(html).toContain("QTD Stale Deal");
    expect(html).toContain("Second QTD Stale Deal");
    expect(html).not.toContain("Old Quarter Stale Deal");
    expect(html).not.toContain("Fresh QTD Deal");
    expect(html).toMatch(/Filtered results.*>2</);
  });

  it("uses engine at-risk results for the KPI count and drilldown population", () => {
    mocks.useDealBoardMock.mockReturnValue({
      board: {
        columns: [
          {
            stage: { id: "stage-contract", name: "Contract", slug: "contract" },
            count: 3,
            totalValue: 600000,
            cards: [
              makeDeal({
                id: "deal-active-risk",
                name: "Active Engine At Risk Deal",
                stageId: "stage-contract",
                stageEnteredAt: "2026-04-01T10:00:00.000Z",
                updatedAt: "2026-05-07T10:00:00.000Z",
                bidEstimate: "250000",
                onHold: false,
                atRisk: makeAtRiskResult(),
              }),
              makeDeal({
                id: "deal-held-not-risk",
                name: "Held Paused Deal",
                stageId: "stage-contract",
                stageEnteredAt: "2026-04-01T10:00:00.000Z",
                updatedAt: "2026-05-07T10:00:00.000Z",
                bidEstimate: "300000",
                onHold: true,
                atRisk: makeAtRiskResult({
                  isAtRisk: false,
                  status: "not_at_risk",
                  severity: "none",
                  reason: "on_hold",
                  effectiveStageAgeSeconds: 0,
                  effectiveStageAgeDays: 0,
                  secondsUntilThreshold: 2 * 86_400,
                  secondsPastThreshold: 0,
                }),
              }),
              makeDeal({
                id: "deal-old-but-engine-safe",
                name: "Old But Engine Safe Deal",
                stageId: "stage-contract",
                stageEnteredAt: "2026-04-01T10:00:00.000Z",
                updatedAt: "2026-05-07T10:00:00.000Z",
                bidEstimate: "50000",
                onHold: false,
                atRisk: makeAtRiskResult({
                  isAtRisk: false,
                  status: "not_at_risk",
                  severity: "none",
                  reason: "within_sla",
                  effectiveStageAgeSeconds: 86_400,
                  effectiveStageAgeDays: 1,
                  secondsUntilThreshold: 86_400,
                  secondsPastThreshold: 0,
                }),
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

    const html = renderPage("/deals?scope=all&filter=at_risk", "director");

    expect(html).toMatch(/At risk.*>1<.*Over SLA/);
    expect(html).toMatch(/Filtered results.*>1</);
    expect(html).toContain("Active Engine At Risk Deal");
    expect(html).not.toContain("Held Paused Deal");
    expect(html).not.toContain("Old But Engine Safe Deal");
  });

  it("sums only non-on-hold deal values for board fallback totals", () => {
    expect(
      sumNonOnHoldDealValues([
        makeDeal({ id: "deal-active", bidEstimate: "250000", ddEstimate: null, onHold: false }),
        makeDeal({ id: "deal-on-hold", bidEstimate: "300000", ddEstimate: null, onHold: true }),
      ])
    ).toBe(250000);
  });

  it("excludes on-hold cards from at-risk drilldown column fallback totals", () => {
    mocks.useDealBoardMock.mockReturnValue({
      board: {
        columns: [
          {
            stage: { id: "stage-contract", name: "Contract", slug: "contract" },
            count: 2,
            totalValue: 550000,
            cards: [
              makeDeal({
                id: "deal-active-risk",
                name: "Active Engine At Risk Deal",
                stageId: "stage-contract",
                bidEstimate: "250000",
                onHold: false,
                atRisk: makeAtRiskResult(),
              }),
              makeDeal({
                id: "deal-on-hold-risk",
                name: "On Hold Engine At Risk Deal",
                stageId: "stage-contract",
                bidEstimate: "300000",
                onHold: true,
                atRisk: makeAtRiskResult({
                  reason: "threshold_reached",
                  effectiveStageAgeSeconds: 12 * 86_400,
                  effectiveStageAgeDays: 12,
                }),
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

    const html = renderPage("/deals?scope=all&filter=at_risk", "director");

    expect(html).toMatch(/Contract.*1\/2.*\$250\.0K/);
    expect(html).not.toMatch(/Contract.*1\/2.*\$550\.0K/);
  });

  it("excludes on-hold cards from search-filtered column totals", async () => {
    mocks.useDealBoardMock.mockReturnValue({
      board: {
        columns: [
          {
            stage: { id: "stage-contract", name: "Contract", slug: "contract" },
            count: 2,
            totalValue: 550000,
            cards: [
              makeDeal({
                id: "deal-active-search",
                name: "Roof Search Active",
                stageId: "stage-contract",
                bidEstimate: "250000",
                onHold: false,
              }),
              makeDeal({
                id: "deal-on-hold-search",
                name: "Roof Search Held",
                stageId: "stage-contract",
                bidEstimate: "300000",
                onHold: true,
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

    const view = await renderPageDom("/deals?scope=all", "director");

    try {
      const input = view.container.querySelector<HTMLInputElement>('input[placeholder="Search deals"]');
      expect(input).not.toBeNull();

      await act(async () => {
        const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        valueSetter?.call(input, "Roof Search");
        input!.dispatchEvent(new Event("input", { bubbles: true }));
      });

      const html = normalize(view.container.innerHTML);
      expect(html).toMatch(/Contract.*1\/2.*\$250\.0K/);
      expect(html).not.toMatch(/Contract.*1\/2.*\$550\.0K/);
    } finally {
      await view.cleanup();
    }
  });

  it("orders SLA drilldown rows by engine effective age instead of raw stage-entered date", () => {
    mocks.useDealBoardMock.mockReturnValue({
      board: {
        columns: [
          {
            stage: { id: "stage-contract", name: "Contract", slug: "contract" },
            count: 2,
            totalValue: 300000,
            cards: [
              makeDeal({
                id: "deal-raw-old",
                name: "Raw Old Short Effective",
                stageId: "stage-contract",
                stageEnteredAt: "2026-04-01T10:00:00.000Z",
                updatedAt: "2026-05-07T10:00:00.000Z",
                bidEstimate: "100000",
                atRisk: makeAtRiskResult({
                  effectiveStageAgeSeconds: 3 * 86_400,
                  effectiveStageAgeDays: 3,
                }),
              }),
              makeDeal({
                id: "deal-raw-new",
                name: "Raw New Long Effective",
                stageId: "stage-contract",
                stageEnteredAt: "2026-05-01T10:00:00.000Z",
                updatedAt: "2026-05-07T10:00:00.000Z",
                bidEstimate: "200000",
                atRisk: makeAtRiskResult({
                  effectiveStageAgeSeconds: 10 * 86_400,
                  effectiveStageAgeDays: 10,
                }),
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

    const html = renderPage("/deals?scope=all&filter=at_risk", "director");

    const drilldownHtml = html.slice(html.indexOf("Filtered results"));
    expect(drilldownHtml.indexOf("Raw New Long Effective")).toBeLessThan(
      drilldownHtml.indexOf("Raw Old Short Effective")
    );
    expect(html).toContain("10d in stage");
    expect(html).toContain("3d in stage");
  });

  it("keeps the embedded list visible for stale drill-down views", () => {
    const html = renderPage("/deals?scope=all&filter=stale&period=qtd", "director");

    expect(mocks.useDealBoardMock).toHaveBeenLastCalledWith(
      "all",
      true,
      expect.any(Object),
      1000,
      { from: "2026-04-01", to: "2026-05-08" },
      undefined,
      {}
    );
    expect(mocks.dealsListSectionMock).not.toHaveBeenCalled();
    expect(html).toContain("Drill-down view: SLA filter applied to list and board.");
    expect(html).toContain("Filtered results");
    expect(html).not.toContain("The filtered board above is the source of truth");
  });

  it("shows a loading state instead of previous at-risk rows while the uncapped board refetch is running", async () => {
    const boardState = {
      board: {
        columns: [
          {
            stage: { id: "stage-contract", name: "Contract", slug: "contract" },
            count: 1,
            totalValue: 200000,
            cards: [
              makeDeal({
                id: "deal-stale-visible",
                name: "Previous At Risk Deal",
                stageId: "stage-contract",
                stageEnteredAt: "2026-04-01T10:00:00.000Z",
                updatedAt: "2026-05-07T10:00:00.000Z",
                bidEstimate: "200000",
                atRisk: makeAtRiskResult(),
              }),
            ],
          },
        ],
        terminalStages: [],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    };
    mocks.useDealBoardMock.mockImplementation(() => boardState);

    const view = await renderPageDom("/deals?scope=all&filter=at_risk&period=week", "director");
    expect(view.container.textContent).toContain("Previous At Risk Deal");

    boardState.loading = true;
    await view.rerender("/deals?scope=all&filter=at_risk&period=week", "director");

    expect(view.container.textContent).toContain("Loading SLA drill-down");
    expect(view.container.textContent).not.toContain("Previous At Risk Deal");

    await view.cleanup();
  });

  it("renders refreshed at-risk rows after the uncapped board fetch completes", () => {
    mocks.useDealBoardMock.mockReturnValue({
      board: {
        columns: [
          {
            stage: { id: "stage-contract", name: "Contract", slug: "contract" },
            count: 1,
            totalValue: 250000,
            cards: [
              makeDeal({
                id: "deal-updated-visible",
                name: "Updated At Risk Deal",
                stageId: "stage-contract",
                stageEnteredAt: "2026-04-01T10:00:00.000Z",
                updatedAt: "2026-05-08T10:00:00.000Z",
                bidEstimate: "250000",
                atRisk: makeAtRiskResult(),
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

    const html = renderPage("/deals?scope=all&filter=at_risk&period=week", "director");

    expect(html).not.toContain("Loading SLA drill-down");
    expect(html).toContain("Updated At Risk Deal");
  });

  it("coerces a requested team scope to mine in the scope toggle (D-12b)", () => {
    const html = renderPage("/deals?scope=team", "director");

    expect(mocks.useDealBoardMock).toHaveBeenLastCalledWith("mine", true, expect.any(Object), 8, null, undefined, {});
    expect(html).not.toContain(">Team</button>");
    expect(html).toContain('aria-pressed="true">Mine');
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
