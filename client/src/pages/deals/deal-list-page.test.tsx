// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { readStoredDealView } from "@/lib/deals-view-preferences";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { act, useEffect } from "react";
import { USD_COMPACT } from "@/components/shared/formatters";
import type { Deal } from "@/hooks/use-deals";
import type { AtRiskResult } from "@trock-crm/shared/types";
import {
  DealListPage,
  buildDealsPageKpiDrilldownPath,
  boardRelevantParamKey,
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

vi.mock("@/components/deals/deals-list-section", async (importOriginal) => ({
  // Keep the real pure helpers (e.g. buildDealStageFilterOptions, used by the base-list stage scope)
  // while stubbing the component itself to capture props.
  ...(await importOriginal<typeof import("@/components/deals/deals-list-section")>()),
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

describe("boardRelevantParamKey (the board sync ignores list-namespace params, Codex #589)", () => {
  it("yields the SAME key when only dl_* (base list) params change — so a list edit doesn't refetch the kanban", () => {
    expect(boardRelevantParamKey("scope=all&period=qtd&dl_stageIds=x&dl_page=2")).toBe(
      boardRelevantParamKey("scope=all&period=qtd&dl_stageIds=y&dl_page=5&dl_status=on_hold")
    );
  });

  it("yields the SAME key when only fb_* (drill-down list) params change — a drill-down list edit must not refetch the kanban either (Codex #589 P3)", () => {
    expect(boardRelevantParamKey("scope=all&period=qtd&filter=won&fb_search=acme&fb_stageIds=x")).toBe(
      boardRelevantParamKey("scope=all&period=qtd&filter=won&fb_search=beta&fb_stageIds=y&fb_page=3")
    );
  });

  it("yields a DIFFERENT key when a board param changes (the board must re-sync)", () => {
    expect(boardRelevantParamKey("scope=all&period=qtd")).not.toBe(
      boardRelevantParamKey("scope=all&period=mtd")
    );
    expect(boardRelevantParamKey("scope=all&assignedRepId=rep-1")).not.toBe(
      boardRelevantParamKey("scope=all&assignedRepId=rep-2")
    );
  });
});

describe("DealListPage", () => {
  beforeEach(() => {
    // The page now persists standing filters to localStorage (deals-view-preferences); clear it between
    // tests so one test's saved Rep/period/dl_ selection can't hydrate into the next (real usage = a fresh
    // session per test).
    window.localStorage.clear();
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
      assignees: [
        { id: "rep-1", displayName: "Brett Jones" },
        { id: "rep-9", displayName: "Nina Nine" },
      ],
      loading: false,
      loadedOfficeId: "office-1",
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
    }, 1000, null, undefined);
    expect(html).toContain("Deals Dashboard"); // relabeled to distinguish the dashboard from /pipeline
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

  it("restores the saved Rep + timeframe on a bare /deals return (hydrates from localStorage)", async () => {
    window.localStorage.setItem(
      "deals-view-preference:user-1:office-1",
      JSON.stringify({ assignedRepId: "rep-9", period: "ytd" }),
    );
    const view = await renderPageDomWithLocation("/deals?scope=all");
    expect(view.searches.some((s) => s.includes("assignedRepId=rep-9"))).toBe(true);
    expect(view.searches.some((s) => s.includes("period=ytd"))).toBe(true);
    await view.cleanup();
  });

  it("does NOT hydrate saved filters into a drill-down deep link (its omitted period/rep are intentional)", async () => {
    window.localStorage.setItem(
      "deals-view-preference:user-1:office-1",
      JSON.stringify({ assignedRepId: "rep-9", period: "ytd" }),
    );
    const view = await renderPageDomWithLocation("/deals?scope=all&filter=won");
    // A ?filter= deep link's omitted period/rep are intentional — never overwritten from the store.
    expect(view.searches.every((s) => !s.includes("assignedRepId=rep-9"))).toBe(true);
    await view.cleanup();
  });

  it("does NOT hydrate into a non-bare base-list deep link (e.g. a shared dl_ link is authoritative)", async () => {
    window.localStorage.setItem(
      "deals-view-preference:user-1:office-1",
      JSON.stringify({ assignedRepId: "rep-9", period: "ytd" }),
    );
    const view = await renderPageDomWithLocation("/deals?scope=all&dl_stageIds=estimating");
    expect(view.searches.every((s) => !s.includes("assignedRepId=rep-9"))).toBe(true);
    await view.cleanup();
  });

  it("restores (does not wipe) saved filters on a same-route return from a drill-down to a bare /deals", async () => {
    window.localStorage.setItem(
      "deals-view-preference:user-1:office-1",
      JSON.stringify({ assignedRepId: "rep-9", period: "ytd" }),
    );
    // Effective scope resolves to All on the bare return, so the saved rep is kept (not dropped as under Mine).
    window.localStorage.setItem("pipeline-scope-preference:user-1", "all");
    mocks.useAuthMock.mockReturnValue({
      user: { id: "user-1", email: "a@b.test", displayName: "T", role: "admin", officeId: "office-1", activeOfficeId: "office-1" },
      loading: false,
    });
    let navigate: (to: string) => void = () => {};
    const locations: string[] = [];
    function Probe() {
      navigate = useNavigate();
      locations.push(useLocation().search);
      return <DealListPage />;
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    let root: Root | null = null;
    await act(async () => {
      root = createRoot(container);
      root.render(
        <MemoryRouter initialEntries={["/deals?scope=all&filter=won"]}>
          <Probe />
        </MemoryRouter>,
      );
    });
    // On the drill-down deep link the store is left untouched.
    expect(readStoredDealView("user-1", "office-1")).toMatchObject({ assignedRepId: "rep-9", period: "ytd" });
    // The sidebar "Deals" link keeps this same route mounted; the return must RESTORE, not save {} and wipe.
    await act(async () => navigate("/deals"));
    expect(readStoredDealView("user-1", "office-1")).toMatchObject({ assignedRepId: "rep-9", period: "ytd" });
    // And the URL itself is hydrated with the restored rep + timeframe.
    const restored = locations[locations.length - 1];
    expect(restored).toContain("assignedRepId=rep-9");
    expect(restored).toContain("period=ytd");
    await act(async () => root?.unmount());
    container.remove();
  });

  it("restores the saved timeframe but NOT a saved rep when the effective scope is Mine (avoids an empty board)", async () => {
    window.localStorage.setItem(
      "deals-view-preference:user-1:office-1",
      JSON.stringify({ assignedRepId: "rep-9", period: "ytd" }),
    );
    // The shared scope preference (owned by scope-preferences, set from any page) resolves to Mine here.
    window.localStorage.setItem("pipeline-scope-preference:user-1", "mine");
    const view = await renderPageDomWithLocation("/deals");
    expect(view.searches.some((s) => s.includes("period=ytd"))).toBe(true);
    expect(view.searches.every((s) => !s.includes("assignedRepId=rep-9"))).toBe(true);
    await view.cleanup();
  });

  it("KEEPS a saved rep under Watched scope (rep narrowing is valid there, unlike Mine)", async () => {
    window.localStorage.setItem(
      "deals-view-preference:user-1:office-1",
      JSON.stringify({ assignedRepId: "rep-9", period: "ytd" }),
    );
    window.localStorage.setItem("pipeline-scope-preference:user-1", "watched");
    const view = await renderPageDomWithLocation("/deals");
    expect(view.searches.some((s) => s.includes("assignedRepId=rep-9"))).toBe(true);
    await view.cleanup();
  });

  it("does NOT restore a stored rep who is no longer a selectable assignee (deactivated / wrong office)", async () => {
    window.localStorage.setItem(
      "deals-view-preference:user-1:office-1",
      JSON.stringify({ assignedRepId: "rep-gone", period: "ytd" }), // rep-gone is not in the assignee list
    );
    const view = await renderPageDomWithLocation("/deals?scope=all");
    expect(view.searches.some((s) => s.includes("period=ytd"))).toBe(true);
    expect(view.searches.every((s) => !s.includes("assignedRepId=rep-gone"))).toBe(true);
    await view.cleanup();
  });

  it("defers hydration while the loaded assignees still belong to a previous office (office-switch race)", async () => {
    // Simulate the hook briefly reporting a stale office's list (loading:false) right after an office switch.
    mocks.useTaskAssigneesMock.mockReturnValue({
      assignees: [{ id: "rep-1", displayName: "Brett Jones" }],
      loading: false,
      loadedOfficeId: "office-STALE",
    });
    window.localStorage.setItem(
      "deals-view-preference:user-1:office-1",
      JSON.stringify({ assignedRepId: "rep-9", period: "ytd" }),
    );
    const view = await renderPageDomWithLocation("/deals?scope=all");
    // Nothing is hydrated yet — not even the timeframe — until the assignee list settles for THIS office
    // (otherwise a valid rep would be validated against the wrong office's list and dropped).
    expect(view.searches.every((s) => !s.includes("period=ytd"))).toBe(true);
    expect(view.searches.every((s) => !s.includes("assignedRepId=rep-9"))).toBe(true);
    await view.cleanup();
  });

  it("still restores the timeframe when the assignee list has finished loading but is empty", async () => {
    mocks.useTaskAssigneesMock.mockReturnValue({ assignees: [], loading: false, loadedOfficeId: "office-1" });
    window.localStorage.setItem(
      "deals-view-preference:user-1:office-1",
      JSON.stringify({ assignedRepId: "rep-9", period: "ytd" }),
    );
    const view = await renderPageDomWithLocation("/deals?scope=all");
    // The office-independent timeframe is restored even though there are no assignees to validate the rep.
    expect(view.searches.some((s) => s.includes("period=ytd"))).toBe(true);
    expect(view.searches.every((s) => !s.includes("assignedRepId=rep-9"))).toBe(true);
    await view.cleanup();
  });

  it("persists a header timeframe change made while on a drill-down, preserving the saved rep (per-key)", async () => {
    window.localStorage.setItem("deals-view-preference:user-1:office-1", JSON.stringify({ assignedRepId: "rep-9" }));
    const view = await renderPageDomWithLocation("/deals?scope=all&filter=won", "director");
    await act(async () => {
      const trigger = view.container.querySelector<HTMLButtonElement>('button[aria-label="Period"]');
      trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      trigger?.click();
    });
    await act(async () => {
      const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
        (el) => el.textContent?.trim() === "YTD",
      );
      option?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
      option?.click();
    });
    // The change made on the drill-down is saved, and the pre-existing rep is kept (not dropped).
    expect(readStoredDealView("user-1", "office-1")).toEqual({ assignedRepId: "rep-9", period: "ytd" });
    await view.cleanup();
  });

  it("layers the Deals page rep into the board and the bid-board drill-down list", () => {
    renderPage("/deals?scope=all&assignedRepId=rep-1&filter=bid_board");

    expect(mocks.useDealBoardMock).toHaveBeenCalledWith(
      "all",
      true,
      { won: { preset: "all" }, lost: { preset: "all" } },
      1000,
      null,
      "rep-1"
    );
    expect(mocks.dealsListSectionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        lockedOwnerId: "rep-1",
        hideOwnerFilter: true,
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
    // USD_COMPACT(180000) is compact currency for 180k. Its trailing ".0" is
    // ICU/V8-version-dependent: Node 20/22 render "$180.0K", Node 24+ render
    // "$180K". The old literal "$180K" pinned one version (and never matched on
    // Node 20/22). Match version-agnostically so this is deterministic everywhere.
    expect(html).toMatch(/Active pipeline.*\$180(\.0)?K.*1\/1 deals/);
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

  it("collapses standalone won_*/lost_* params when there is no shared period — the board reads ?period, not per-column overrides (Option A)", () => {
    renderPage("/deals?scope=all&won_preset=30&lost_preset=60");

    expect(mocks.useDealBoardMock).toHaveBeenCalledWith("all", true, {
      won: { preset: "all" },
      lost: { preset: "all" },
    }, 1000, null, undefined);
  });

  it("strips stale estimate_sent_* params from the URL on load — the removed control must not invisibly filter the board or a stage drill-down (Codex #600 P2)", async () => {
    const view = await renderPageDomWithLocation("/deals?scope=all&estimate_sent_since=2026-04-01&estimate_sent_until=2026-04-30");
    expect(lastSearch(view.searches)).not.toContain("estimate_sent_");
    expect(lastSearch(view.searches)).toContain("scope=all");
    await view.cleanup();
  });

  it("requests an expanded preview window for the SLA drill-down board with NO board period (current-state)", () => {
    renderPage("/deals?scope=all&filter=at_risk&period=week", "director");

    // Deals-at-Risk is current-state: the board-wide period (arg 5) is null even with ?period=week, so the
    // server does not window the OPEN columns by stage_entered_at and drops no at-risk deals at the source.
    // (The Won/Lost terminal presets in arg 3 are moot here — terminal columns aren't shown on this view.)
    expect(mocks.useDealBoardMock).toHaveBeenCalledWith("all", true, {
      won: { preset: "all" },
      lost: { preset: "wtd" },
    }, 1000, null, undefined);
  });

  it("passes the selected page period to the board request so won aggregates match the drilldown window", () => {
    renderPage("/deals?scope=all&period=last_month&won_preset=30", "director");

    expect(mocks.useDealBoardMock).toHaveBeenCalledWith("all", true, {
      won: { preset: "all" }, // Option A: the stale won_preset is collapsed; the board-wide won_period (arg5) windows Won
      lost: { preset: "custom", customStart: "2026-04-01", customEnd: "2026-04-30" }, // Lost seeded from last_month
    }, 1000, { from: "2026-04-01", to: "2026-04-30" }, undefined);
  });

  describe("Option A: one board-wide date — Won & Lost columns mirror the shared ?period", () => {
    it("renders period-vocabulary date controls on the Won and Lost columns, both showing the shared period", async () => {
      const view = await renderPageDom("/deals?scope=all&period=qtd", "director");
      const won = view.container.querySelector<HTMLButtonElement>('button[aria-label="Won date range"]');
      const lost = view.container.querySelector<HTMLButtonElement>('button[aria-label="Lost date range"]');
      expect(won?.textContent).toContain("QTD");
      expect(lost?.textContent).toContain("QTD");
      // The old per-column rich-vocab control (which owned the divergent won_*/lost_* override) is gone.
      expect(view.container.querySelector('button[aria-label="Won date filter"]')).toBeNull();
      await view.cleanup();
    });

    it("changing the Won column date writes the shared ?period (never won_*) and mirrors onto the top control + the Lost column", async () => {
      const view = await renderPageDomWithLocation("/deals?scope=all&period=qtd", "director");
      await act(async () => {
        const trigger = view.container.querySelector<HTMLButtonElement>('button[aria-label="Won date range"]');
        trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        trigger?.click();
      });
      await act(async () => {
        const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
          (el) => el.textContent?.trim() === "MTD"
        );
        option?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
        option?.click();
      });
      expect(lastSearch(view.searches)).toContain("period=mtd");
      expect(lastSearch(view.searches)).not.toContain("won_");
      expect(lastSearch(view.searches)).not.toContain("lost_");
      // The top control and the Lost column reflect the same shared period.
      expect(view.container.querySelector('button[aria-label="Period"]')?.textContent).toContain("MTD");
      expect(view.container.querySelector('button[aria-label="Lost date range"]')?.textContent).toContain("MTD");
      await view.cleanup();
    });

    it("changing the Lost column date sets the SAME shared period — Won and Lost can never diverge", async () => {
      const view = await renderPageDomWithLocation("/deals?scope=all&period=qtd", "director");
      await act(async () => {
        const trigger = view.container.querySelector<HTMLButtonElement>('button[aria-label="Lost date range"]');
        trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        trigger?.click();
      });
      await act(async () => {
        const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
          (el) => el.textContent?.trim() === "YTD"
        );
        option?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
        option?.click();
      });
      expect(lastSearch(view.searches)).toContain("period=ytd");
      expect(view.container.querySelector<HTMLButtonElement>('button[aria-label="Won date range"]')?.textContent).toContain("YTD");
      expect(view.container.querySelector<HTMLButtonElement>('button[aria-label="Lost date range"]')?.textContent).toContain("YTD");
      await view.cleanup();
    });

    it("collapses stale per-column won_*/lost_* params — the board reads the single shared period only", () => {
      renderPage("/deals?scope=all&period=qtd&won_preset=30&lost_preset=60", "director");
      expect(mocks.useDealBoardMock).toHaveBeenLastCalledWith(
        "all",
        true,
        { won: { preset: "all" }, lost: { preset: "qtd" } },
        1000,
        expect.objectContaining({ from: expect.any(String), to: expect.any(String) }),
        undefined
      );
    });

    it("strips stale won_*/lost_* params from the URL on load so they can't leak into a stage drill-down", async () => {
      const view = await renderPageDomWithLocation(
        "/deals?scope=all&period=qtd&won_preset=30&lost_since=2026-03-01",
        "director"
      );
      expect(lastSearch(view.searches)).not.toContain("won_");
      expect(lastSearch(view.searches)).not.toContain("lost_");
      expect(lastSearch(view.searches)).toContain("period=qtd");
      await view.cleanup();
    });

    it("a single column-date change keeps the board lockstep — every period-windowed fetch also windows Lost (#600 P2)", async () => {
      const view = await renderPageDomWithLocation("/deals?scope=all", "director");
      await act(async () => {
        const trigger = view.container.querySelector<HTMLButtonElement>('button[aria-label="Lost date range"]');
        trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        trigger?.click();
      });
      await act(async () => {
        const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
          (el) => el.textContent?.trim() === "Last month"
        );
        option?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
        option?.click();
      });
      expect(lastSearch(view.searches)).toContain("period=last_month");
      expect(lastSearch(view.searches)).not.toContain("won_");
      expect(lastSearch(view.searches)).not.toContain("lost_");
      const callsWithPeriod = mocks.useDealBoardMock.mock.calls.filter((call) => call[4] != null);
      expect(callsWithPeriod.length).toBeGreaterThan(0);
      for (const call of callsWithPeriod) {
        expect((call[2] as { lost: unknown }).lost).not.toEqual({ preset: "all" });
      }
      await view.cleanup();
    });

    it("opens the Won stage drill-down windowed by the shared period, not all-time — the visibly-QTD column drills into QTD (Codex P2)", async () => {
      const view = await renderPageDom("/deals?scope=all&period=qtd", "director");
      const wonStageButton = Array.from(
        view.container.querySelectorAll<HTMLButtonElement>("button")
      ).find((button) => button.textContent?.trim() === "Won");
      expect(wonStageButton).toBeTruthy();

      await act(async () => {
        wonStageButton?.click();
      });

      const calls = mocks.buildDealStageWorkspacePathMock.mock.calls;
      const lastCall = calls[calls.length - 1]?.[0] as {
        stageSlug?: string;
        filters?: Record<string, { preset?: string }>;
      };
      expect(lastCall?.stageSlug).toBe("won");
      // The Won stage page has no won_period sibling, so it must be windowed by the period directly —
      // NOT all-time, which would contradict the visibly QTD-windowed Won column.
      expect(lastCall?.filters?.won).toEqual({ preset: "qtd" });
      expect(lastCall?.filters?.lost).toEqual({ preset: "qtd" });

      await view.cleanup();
    });

    it("opens the Won stage drill-down for ?period=today with the real today window (no #566 board-only all-time dodge on the stage page)", async () => {
      const view = await renderPageDom("/deals?scope=all&period=today", "director");
      const wonStageButton = Array.from(
        view.container.querySelectorAll<HTMLButtonElement>("button")
      ).find((button) => button.textContent?.trim() === "Won");

      await act(async () => {
        wonStageButton?.click();
      });

      const calls = mocks.buildDealStageWorkspacePathMock.mock.calls;
      const lastCall = calls[calls.length - 1]?.[0] as {
        filters?: Record<string, unknown>;
      };
      // ?period=today routes the BOARD's Won column to {all} (the #566 won_period clamp dodge), but the
      // stage page has no won_period sibling, so it gets the REAL today window — not all-time.
      expect(lastCall?.filters?.won).toEqual({
        preset: "custom",
        customStart: "2026-05-08",
        customEnd: "2026-05-08",
      });

      await view.cleanup();
    });
  });

  describe("D-7: Won drill-down chip inherits the page period (no contradictory all_time+period)", () => {
    it("seeds the Won terminal filter from the inherited period when the URL has no explicit Won filter", () => {
      const resolved = resolveDrilldownTerminalDateFilters(
        new URLSearchParams("filter=won&period=qtd&scope=all"),
        new Date("2026-05-31T12:00:00.000Z")
      );
      expect(resolved.won).toEqual({ preset: "qtd" });
      expect(resolved.lost).toEqual({ preset: "qtd" }); // Lost also seeded from the period (Codex #600 P2)
    });

    it("collapses an explicit won_* override — the shared period wins (Option A; per-column overrides removed)", () => {
      expect(
        resolveDrilldownTerminalDateFilters(new URLSearchParams("filter=won&period=qtd&won_preset=30&scope=all")).won
      ).toEqual({ preset: "qtd" });
      expect(
        resolveDrilldownTerminalDateFilters(new URLSearchParams("filter=won&period=qtd&won_all_time=true&scope=all")).won
      ).toEqual({ preset: "qtd" });
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

    it("still windows the LOST column for period=today (Won's today->all dodge is won_period-specific; Lost has no such sibling, so ?period=today must not leave Lost all-time) (Codex #600 P2)", () => {
      const resolved = resolveDrilldownTerminalDateFilters(
        new URLSearchParams("period=today&scope=all"),
        new Date("2026-05-31T12:00:00.000Z")
      );
      expect(resolved.won).toEqual({ preset: "all" }); // Won stays all (the #566 clamp dodge)
      expect(resolved.lost).toEqual({ preset: "custom", customStart: "2026-05-31", customEnd: "2026-05-31" });
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

    expect(mocks.useDealBoardMock).toHaveBeenCalledWith("mine", true, expect.any(Object), 1000, null, undefined);
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
    expect(mocks.useDealBoardMock).toHaveBeenLastCalledWith("mine", true, expect.any(Object), 1000, null, undefined);

    renderPage("/deals", "director");
    expect(mocks.useDealBoardMock).toHaveBeenLastCalledWith("mine", true, expect.any(Object), 1000, null, undefined);

    renderPage("/deals", "admin");
    expect(mocks.useDealBoardMock).toHaveBeenLastCalledWith("mine", true, expect.any(Object), 1000, null, undefined);

    renderPage("/deals?scope=mine", "director");
    expect(mocks.useDealBoardMock).toHaveBeenLastCalledWith("mine", true, expect.any(Object), 1000, null, undefined);
  });

  it("hides the Team scope and coerces a requested team scope to mine (D-12b)", () => {
    const html = renderPage("/deals?scope=team", "rep");

    // Team is no longer offered and never reaches the board hook: ?scope=team is
    // coerced to the rendered fallback ("mine"); no dead placeholder is shown.
    expect(html).not.toContain(">Team</button>");
    expect(html).not.toContain("Team view is not yet configured");
    expect(mocks.useDealBoardMock).toHaveBeenLastCalledWith("mine", true, expect.any(Object), 1000, null, undefined);
  });

  it("drops a stale owner filter when a team bookmark is coerced to mine (D-12b)", () => {
    renderPage("/deals?scope=team&assignedRepId=rep-2", "director");

    // Coerced to mine AND the owner filter cleared (6th arg undefined), so the Mine board is
    // not intersected with rep-2's deals into an empty result.
    expect(mocks.useDealBoardMock).toHaveBeenLastCalledWith("mine", true, expect.any(Object), 1000, null, undefined);
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

    expect(mocks.useDealBoardMock).toHaveBeenLastCalledWith("all", true, expect.any(Object), 1000, null, undefined);
    expect(html).toContain('aria-pressed="false">Mine');
    expect(html).toContain('aria-pressed="true">All');
    // Team is not an offered scope (D-12b).
    expect(html).not.toContain(">Team</button>");
  });
  it("offers a third Watched scope pill and selects it for ?scope=watched (deals-only filter)", () => {
    const html = renderPage("/deals?scope=watched", "rep");

    // The new pill renders AND is active; Mine/All stay (unchanged).
    expect(html).toContain('aria-pressed="true">Watched');
    expect(html).toContain('aria-pressed="false">Mine');
    expect(html).toContain('aria-pressed="false">All');
    // watched survives end-to-end (not silently coerced to mine) — the board hook receives it.
    expect(mocks.useDealBoardMock).toHaveBeenLastCalledWith("watched", true, expect.any(Object), 1000, null, undefined);
  });
  it("mounts the FULL FilterBar (incl. Rep, dl_-namespaced) on the BASE deal list, inheriting scope; Scope omitted", () => {
    renderPage("/deals?scope=mine", "director");

    expect(mocks.dealsListSectionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowFamily: "deal",
        scope: "mine", // inherited from the page toggle
        enableExport: true,
        filterBar: expect.objectContaining({
          paramPrefix: "dl_", // namespaced so the list can't collide with the header's bare params
          dimensions: expect.arrayContaining(["search", "date", "stage", "sort", "rep", "status", "value", "stalled"]),
        }),
      })
    );
    const props = mocks.dealsListSectionMock.mock.calls[mocks.dealsListSectionMock.mock.calls.length - 1][0] as {
      filterBar: { dimensions: string[] };
      enableDateFilter?: boolean;
    };
    // Rep IS in the bar now (it nests under the header Rep); Scope stays the page toggle's.
    expect(props.filterBar.dimensions).toContain("rep");
    expect(props.filterBar.dimensions).not.toContain("scope");
    // The legacy inline filter row is gone (FilterBar mode supersedes it).
    expect(props.enableDateFilter).toBeUndefined();
  });

  it("drops the Rep dimension entirely when the header pins a concrete rep (no no-op single-rep control, no misleading Unassigned) (Codex #589 P2)", () => {
    mocks.useTaskAssigneesMock.mockReturnValue({
      assignees: [
        { id: "rep-1", displayName: "Brett Jones" },
        { id: "rep-2", displayName: "Adam Smith" },
      ],
    });
    renderPage("/deals?scope=all&assignedRepId=rep-2", "director");
    const props = mocks.dealsListSectionMock.mock.calls[mocks.dealsListSectionMock.mock.calls.length - 1][0] as {
      filterBar: { dimensions: string[] };
    };
    // The header already owns rep-2; a bar Rep control could only offer rep-2 (a no-op) and would still
    // surface an "Unassigned" option that reconciliation clamps back to rep-2 (misleading). Drop it.
    expect(props.filterBar.dimensions).not.toContain("rep");
  });

  it("passes CANONICAL stage sibling families (cross-slug aliases grouped by board column) so an explicit pick includes every member id (Codex #589 P1)", () => {
    // contract_signed + service_contract_signed are DIFFERENT raw slugs the board collapses into the one
    // canonical "Contract" column. The family must group them together (raw-slug grouping would split
    // them), or selecting Contract under-shows the service-contract deals.
    mocks.usePipelineStagesMock.mockReturnValue({
      loading: false,
      error: null,
      stages: [
        { id: "contract-standard", name: "Contract", slug: "contract_signed", displayOrder: 5, isTerminal: false },
        { id: "contract-service", name: "Contract", slug: "service_contract_signed", displayOrder: 5, isTerminal: false },
      ],
    });
    renderPage("/deals?scope=mine", "director");
    const props = mocks.dealsListSectionMock.mock.calls[mocks.dealsListSectionMock.mock.calls.length - 1][0] as {
      filterBar: { stageIdFamilies?: string[][] };
    };
    const contractFamily = props.filterBar.stageIdFamilies?.find((ids) => ids.includes("contract-standard"));
    expect(contractFamily).toEqual(expect.arrayContaining(["contract-standard", "contract-service"]));
  });

  it("classifies Won/Lost ALIAS ids as terminal by CANONICAL slug so their inactive rows survive the active-only default (Codex #589)", () => {
    // closed_won / service_lost are terminal stages whose RAW slug is not literally 'won'/'lost'. A raw-slug
    // terminal predicate would omit them from terminalStageIds → the active-only default would drop those
    // inactive deals from the base list, mismatching the board's Won/Lost columns.
    mocks.usePipelineStagesMock.mockReturnValue({
      loading: false,
      error: null,
      stages: [
        { id: "won-canonical", name: "Won", slug: "won", displayOrder: 6, isTerminal: true },
        { id: "won-closed", name: "Closed Won", slug: "closed_won", displayOrder: 6, isTerminal: true },
        { id: "lost-service", name: "Service Lost", slug: "service_lost", displayOrder: 7, isTerminal: true },
      ],
    });
    renderPage("/deals?scope=mine", "director");
    const props = mocks.dealsListSectionMock.mock.calls[mocks.dealsListSectionMock.mock.calls.length - 1][0] as {
      filterBar: { terminalStageIds: string[] };
    };
    expect(props.filterBar.terminalStageIds).toEqual(
      expect.arrayContaining(["won-canonical", "won-closed", "lost-service"])
    );
  });

  it("expands a canonical Estimate-Under-Review pick to BOTH the standard and service-alias ids (list == board column, Codex #589 #1)", () => {
    mocks.usePipelineStagesMock.mockReturnValue({
      loading: false,
      error: null,
      stages: [
        { id: "eur-standard", name: "Estimate Under Review", slug: "estimate_under_review", displayOrder: 4, isTerminal: false },
        { id: "eur-service", name: "Estimate Under Review", slug: "service_estimate_under_review", displayOrder: 4, isTerminal: false },
      ],
    });
    renderPage("/deals?scope=mine", "director");
    const props = mocks.dealsListSectionMock.mock.calls[mocks.dealsListSectionMock.mock.calls.length - 1][0] as {
      filterBar: { stageIdFamilies?: string[][] };
    };
    const eurFamily = props.filterBar.stageIdFamilies?.find((ids) => ids.includes("eur-standard"));
    expect(eurFamily).toEqual(expect.arrayContaining(["eur-standard", "eur-service"]));
  });

  it("mounts a drill-down FilterBar on drill-down views (YELLOW's #590 surface), NAMESPACED distinct from the base list's dl_ mount", () => {
    // Post-#590, drill-downs are no longer the legacy list — they carry their own namespaced FilterBar.
    // RED's base mount uses dl_; the drill-down must use a DIFFERENT prefix so the two never collide.
    renderPage("/deals?filter=won&scope=mine", "director");
    const props = mocks.dealsListSectionMock.mock.calls[mocks.dealsListSectionMock.mock.calls.length - 1][0] as {
      filterBar?: { paramPrefix?: string };
    };
    expect(props.filterBar).toBeDefined();
    expect(props.filterBar?.paramPrefix).not.toBe("dl_");
  });

  it("includes ALL workflow-family stage IDs in the base list's default stage scope — no silent family drop (Codex #589 P1)", () => {
    // Two stages share the canonical slug 'opportunity' (standard + service families). The default
    // stage scope must contain BOTH ids, or the default /deals list would drop one family's deals.
    mocks.usePipelineStagesMock.mockReturnValue({
      loading: false,
      error: null,
      stages: [
        { id: "opp-standard", name: "Opportunity", slug: "opportunity", displayOrder: 1, isTerminal: false },
        { id: "opp-service", name: "Opportunity", slug: "opportunity", displayOrder: 1, isTerminal: false },
      ],
    });
    renderPage("/deals?scope=mine", "director");
    const props = mocks.dealsListSectionMock.mock.calls[mocks.dealsListSectionMock.mock.calls.length - 1][0] as {
      filterBar: { defaultStageIds: string[] };
    };
    expect(props.filterBar.defaultStageIds).toEqual(expect.arrayContaining(["opp-standard", "opp-service"]));
  });

  it("builds clickable KPI drilldown paths with preserved scope and period", () => {
    expect(buildDealsPageKpiDrilldownPath("active_pipeline", "all")).toBe(
      "/deals?filter=active_pipeline&scope=all"
    );
    expect(buildDealsPageKpiDrilldownPath("won", "team", "last_month")).toBe(
      "/deals?filter=won&scope=team&period=last_month"
    );
    // Option A: a stale per-column won_* override is NOT forwarded — the Won drill-down inherits the shared period.
    expect(
      buildDealsPageKpiDrilldownPath("won", "team", "last_month", {
        wonQueryParams: new URLSearchParams("won_preset=30&won_since=2026-04-01&won_until=2026-04-30"),
      })
    ).toBe("/deals?filter=won&scope=team&period=last_month");
    expect(
      buildDealsPageKpiDrilldownPath("active_pipeline", "all", null, {
        queryParams: new URLSearchParams("assignedRepId=rep-1&period=mtd&search=roof"),
      })
    ).toBe("/deals?filter=active_pipeline&scope=all&assignedRepId=rep-1&period=mtd"); // rep + period preserved; search dropped (Codex #600 P2)
    expect(buildDealsPageKpiDrilldownPath("at_risk", "mine")).toBe(
      "/deals?filter=at_risk&scope=mine"
    );
    // SLA drill-downs (at_risk / stale) must DROP ?period even when the page URL carries it: there period
    // becomes updatedFrom/updatedTo (matchesUpdatedRange), a different axis than the SLA card count, so a
    // perioded at-risk link would show a different cohort than the card (Codex #600 P2). Rep still preserved.
    expect(
      buildDealsPageKpiDrilldownPath("at_risk", "all", null, {
        queryParams: new URLSearchParams("assignedRepId=rep-1&period=last_month"),
      })
    ).toBe("/deals?filter=at_risk&scope=all&assignedRepId=rep-1");
    expect(
      buildDealsPageKpiDrilldownPath("stale", "all", null, {
        queryParams: new URLSearchParams("period=mtd"),
      })
    ).toBe("/deals?filter=stale&scope=all");
  });

  it("renders clickable KPI cards on the deals page", () => {
    const html = renderPage("/deals?scope=all&period=last_month&assignedRepId=rep-1", "director");

    // Period is preserved through the OUTCOME-AWARE drill-downs (active pipeline / Won) so the cohort matches
    // the page clicked from — but the at-risk (SLA) drill-down must DROP it, since period there becomes an
    // updated-date window that mismatches the SLA card count (Codex #600 P2).
    expect(html).toContain('href="/deals?filter=active_pipeline&amp;scope=all&amp;period=last_month&amp;assignedRepId=rep-1"');
    expect(html).toContain('href="/deals?filter=won&amp;scope=all&amp;period=last_month&amp;assignedRepId=rep-1"');
    expect(html).toContain('href="/deals?filter=at_risk&amp;scope=all&amp;assignedRepId=rep-1"');
    expect(html).toContain("View active pipeline deals");
    expect(html).toContain("View won deals");
    expect(html).toContain("View at-risk deals");
  });

  it("replaces the Estimate-Sent control with a working header period dropdown that drives the board (period control)", () => {
    const html = renderPage("/deals?scope=all&period=mtd", "director");
    // The useless Estimate-Sent control is GONE (it only filtered the Estimate-Sent column).
    expect(html).not.toContain("Estimate Sent to Client date filter");
    // ?period now windows the cards + read-only board board-wide via useDealBoard arg5 (wonPeriodRange).
    const call = mocks.useDealBoardMock.mock.calls[mocks.useDealBoardMock.mock.calls.length - 1];
    expect(call[4]).toEqual(expect.objectContaining({ from: expect.any(String), to: expect.any(String) })); // period range
  });

  it("changes the period and its derived Lost window in LOCKSTEP — the board never fetches a new won_period with a stale all-time Lost (Codex #600 P2)", async () => {
    const view = await renderPageDomWithLocation("/deals?scope=all", "director");

    const trigger = view.container.querySelector<HTMLButtonElement>('button[aria-label="Period"]');
    // Base UI's Select opens on pointerdown (not a bare click) in jsdom.
    await act(async () => {
      trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      trigger?.click();
    });
    await act(async () => {
      const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
        (el) => el.textContent?.trim() === "Last month"
      );
      // Base UI's SelectItem only commits a click on a HIGHLIGHTED item (or a touch pointer); a non-touch
      // click on an unhighlighted option is a no-op. Mark the pointer as touch so the click commits in jsdom.
      option?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
      option?.click();
    });

    // The URL moved to last_month.
    expect(lastSearch(view.searches)).toContain("period=last_month");

    // Every board fetch carrying a period window (arg5) must also carry the period-derived Lost window
    // (arg3.lost) — NEVER the stale all-time Lost. Without the lockstep, the render between the ?period write
    // and the URL-sync effect fires exactly that mismatched combo.
    const callsWithPeriodWindow = mocks.useDealBoardMock.mock.calls.filter((call) => call[4] != null);
    expect(callsWithPeriodWindow.length).toBeGreaterThan(0);
    for (const call of callsWithPeriodWindow) {
      expect((call[2] as { lost: unknown }).lost).not.toEqual({ preset: "all" });
    }
    // And the settled board fetch windows BOTH the period (arg5) and the Lost column to last_month.
    expect(mocks.useDealBoardMock).toHaveBeenLastCalledWith(
      "all",
      true,
      expect.objectContaining({ lost: { preset: "custom", customStart: "2026-04-01", customEnd: "2026-04-30" } }),
      1000,
      expect.objectContaining({ from: expect.any(String), to: expect.any(String) }),
      undefined
    );

    await view.cleanup();
  });

  it("nests the base list within ?period — feeds the period window into baseFilters as outcome-aware dateFrom/dateTo so the bar Date narrows WITHIN it", () => {
    renderPage("/deals?scope=all&period=mtd", "director");
    const props = mocks.dealsListSectionMock.mock.calls[mocks.dealsListSectionMock.mock.calls.length - 1][0] as {
      baseFilters?: { dateFrom?: string; dateTo?: string };
    };
    expect(props.baseFilters).toEqual(
      expect.objectContaining({ dateFrom: expect.any(String), dateTo: expect.any(String) })
    );
  });

  it("clears ?period from the base list baseFilters when no period is selected (All time)", () => {
    renderPage("/deals?scope=all", "director");
    const props = mocks.dealsListSectionMock.mock.calls[mocks.dealsListSectionMock.mock.calls.length - 1][0] as {
      baseFilters?: { dateFrom?: string; dateTo?: string };
    };
    expect(props.baseFilters?.dateFrom).toBeUndefined();
    expect(props.baseFilters?.dateTo).toBeUndefined();
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

  it("points the Won KPI drilldown link at the shared period only — stale won_* overrides are collapsed (Option A)", () => {
    const html = renderPage("/deals?scope=all&period=last_month&won_preset=30&won_since=2026-04-01&won_until=2026-04-30", "director");

    // The Won KPI card links to the period-windowed Won drill-down; the per-column won_* override is not forwarded.
    expect(html).toContain('href="/deals?filter=won&amp;scope=all&amp;period=last_month"');
    expect(html).not.toContain("won_preset=30");
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
        // Option A: the stale won_preset is collapsed; the Won drill-down column inherits the period window.
        won: { preset: "custom", customStart: "2026-04-01", customEnd: "2026-04-30" },
        lost: { preset: "custom", customStart: "2026-04-01", customEnd: "2026-04-30" }, // Lost seeded from last_month (Codex #600 P2)
      },
      1000,
      { from: "2026-04-01", to: "2026-04-30" },
      undefined
    );
    expect(mocks.dealsListSectionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseFilters: expect.objectContaining({
          // Won drill-down now gates on the true HubSpot close-won date (§6.1),
          // not contract_signed (which is reserved for the commissions surface). The window is the
          // period (last_month) — the per-column override no longer narrows it (Option A).
          wonClosedFrom: "2026-04-01",
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

  it("mounts RED's dl_-namespaced FilterBar on the base view (filter === null) — #589, distinct from the drill-down bar", () => {
    renderPage("/deals?scope=all", "director");
    const props = mocks.dealsListSectionMock.mock.calls[mocks.dealsListSectionMock.mock.calls.length - 1]?.[0] as { filterBar?: { paramPrefix?: string } };
    expect(props.filterBar).toBeDefined();
    expect(props.filterBar?.paramPrefix).toBe("dl_");
  });

  it("shows the running-total card on the base /deals list (#4: SUM over the full filtered set, all pages)", () => {
    renderPage("/deals?scope=all", "director");
    const props = mocks.dealsListSectionMock.mock.calls[mocks.dealsListSectionMock.mock.calls.length - 1]?.[0] as {
      showValueTotal?: boolean;
    };
    expect(props.showValueTotal).toBe(true);
  });

  it("shows the running-total card on a /deals drill-down list (#4)", () => {
    renderPage("/deals?filter=won&scope=all", "director");
    const props = mocks.dealsListSectionMock.mock.calls[mocks.dealsListSectionMock.mock.calls.length - 1]?.[0] as {
      showValueTotal?: boolean;
    };
    expect(props.showValueTotal).toBe(true);
  });

  it("gates the base FilterBar mount until stage metadata loads — no unscoped first request on cold load (Codex)", () => {
    mocks.usePipelineStagesMock.mockReturnValue({ loading: true, error: null, stages: [] }); // not loaded yet
    renderPage("/deals?scope=all", "director");
    const props = mocks.dealsListSectionMock.mock.calls[mocks.dealsListSectionMock.mock.calls.length - 1]?.[0] as { filterBar?: unknown };
    // stages:[] → defaultStageIds would be [] → unscoped query; render in legacy mode (filterBar undefined),
    // which gates the query on stage loading, until metadata arrives.
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

  it("captions the Won KPI from the shared period — a stale per-column override is collapsed (Option A)", () => {
    const htmlWithStaleOverride = renderPage("/deals?scope=all&period=last_month&won_preset=30", "director");
    const htmlWithPeriodOnly = renderPage("/deals?scope=all&period=last_month", "director");
    const htmlAllTime = renderPage("/deals?scope=all", "director");

    // The stale won_preset is collapsed — the caption follows the period, identical to the period-only URL.
    expect(htmlWithStaleOverride).toContain("Last month");
    expect(htmlWithStaleOverride).not.toContain("Last 30 days");
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

  // CONVENTION SHIFT: "Stale"/"Deals At Risk" are CURRENT-STATE views — ?period is a deliberate no-op
  // (period-windowing by updated_at would hide the stalest, most at-risk deals). So even with ?period=qtd,
  // ALL at-risk deals show regardless of updated_at; only the non-at-risk deal is excluded (by predicate).
  it("shows ALL at-risk stale deals regardless of ?period (current-state view); excludes non-at-risk", () => {
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

    // Even with ?period=qtd, the board fetch must carry NO period on the at-risk/stale drill-down — else
    // the server windows the OPEN columns by stage_entered_at (won_period) and drops at-risk deals at the
    // SOURCE. The 5th arg (period range) must be null for current-state.
    expect(mocks.useDealBoardMock).toHaveBeenCalledWith("all", true, expect.any(Object), 1000, null, undefined);

    expect(html).toContain("QTD Stale Deal");
    expect(html).toContain("Second QTD Stale Deal");
    // The out-of-quarter stale deal is the MOST at-risk (oldest) — current-state view keeps it.
    expect(html).toContain("Old Quarter Stale Deal");
    // The non-at-risk deal is still excluded by the engine predicate, not by period.
    expect(html).not.toContain("Fresh QTD Deal");
    expect(html).toMatch(/Filtered results.*>3</);
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

  it("shows explicit stage and project-owner fields in the SLA drilldown list", async () => {
    mocks.useDealBoardMock.mockReturnValue({
      board: {
        columns: [
          {
            stage: { id: "stage-contract", name: "Contract", slug: "contract" },
            count: 3,
            totalValue: 350000,
            cards: [
              makeDeal({
                id: "deal-owned",
                name: "Owned At Risk Deal",
                stageId: "stage-contract",
                assignedRepName: "Brett Jones",
                bidEstimate: "200000",
                atRisk: makeAtRiskResult(),
              }),
              makeDeal({
                id: "deal-unassigned",
                name: "Unassigned At Risk Deal",
                stageId: "stage-contract",
                assignedRepId: null,
                assignedRepName: null,
                bidEstimate: "100000",
                atRisk: makeAtRiskResult(),
              }),
              makeDeal({
                id: "deal-owner-name-missing",
                name: "Unknown Owner At Risk Deal",
                stageId: "stage-contract",
                assignedRepId: "inactive-rep",
                assignedRepName: null,
                bidEstimate: "50000",
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

    const view = await renderPageDom("/deals?scope=all&filter=at_risk", "director");
    try {
      const drilldownText = view.container.textContent ?? "";
      expect(drilldownText).toContain("Project");
      expect(drilldownText).toContain("Stage");
      expect(drilldownText).toContain("Project owner");
      expect(drilldownText).toContain("Time in stage");
      expect(drilldownText).toContain("Last updated");
      expect(drilldownText).toContain("Value");

      expect(
        view.container.querySelector('button[aria-label^="Open project Owned At Risk Deal;"]')?.getAttribute("aria-label")
      ).toBe(
        `Open project Owned At Risk Deal; stage Contract; project owner Brett Jones; time in stage 8d; last updated 2026-04-20; value ${USD_COMPACT(200000)}`
      );
      expect(
        view.container.querySelector('button[aria-label^="Open project Unassigned At Risk Deal;"]')?.getAttribute("aria-label")
      ).toContain("project owner Unassigned");
      expect(
        view.container.querySelector('button[aria-label^="Open project Unknown Owner At Risk Deal;"]')?.getAttribute("aria-label")
      ).toContain("project owner Unknown owner");
    } finally {
      await view.cleanup();
    }
  });

  it("keeps the embedded list visible for stale drill-down views", () => {
    const html = renderPage("/deals?scope=all&filter=stale&period=qtd", "director");

    // Current-state: the board carries NO period on the stale drill-down (arg 5 = null), even with ?period=qtd.
    expect(mocks.useDealBoardMock).toHaveBeenLastCalledWith(
      "all",
      true,
      expect.any(Object),
      1000,
      null,
      undefined
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

    expect(mocks.useDealBoardMock).toHaveBeenLastCalledWith("mine", true, expect.any(Object), 1000, null, undefined);
    expect(html).not.toContain(">Team</button>");
    expect(html).toContain('aria-pressed="true">Mine');
    expect(html).toContain('aria-pressed="false">All');
  });

  it("renders the shared period date control on both terminal columns, not the old per-column override (Option A)", async () => {
    const view = await renderPageDom("/deals?scope=all&period=qtd", "director");

    expect(view.container.innerHTML).not.toContain("Coverage map");
    expect(view.container.innerHTML).not.toContain("DFW map");
    // Period-vocabulary controls on both terminal columns, bound to the shared ?period.
    expect(view.container.querySelector('button[aria-label="Won date range"]')).not.toBeNull();
    expect(view.container.querySelector('button[aria-label="Lost date range"]')).not.toBeNull();
    // The old per-column rich-vocab override control (with its own won_*/lost_* params) is gone.
    expect(view.container.querySelector('button[aria-label="Won date filter"]')).toBeNull();
    expect(view.container.querySelector('button[aria-label="Lost date filter"]')).toBeNull();

    await view.cleanup();
  });

  it("shows a selected-range empty state for empty terminal columns when a board date is active", () => {
    mocks.useDealBoardMock.mockReturnValue({
      board: { columns: [], terminalStages: [] },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = renderPage("/deals?scope=all&period=qtd");

    expect(html).toContain("No deals in selected range");
  });
});
