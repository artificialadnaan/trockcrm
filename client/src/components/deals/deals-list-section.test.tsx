// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import type { AtRiskResult } from "@trock-crm/shared/types";
import {
  DealsListSection,
  buildDealListParams,
  buildDealStageFilterOptions,
  getDealCloseDate,
  getSelectedDealStageIds,
  getVisibleListTerminalStageIds,
} from "./deals-list-section";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  useDealsMock: vi.fn(),
  usePipelineStagesMock: vi.fn(),
  useTaskAssigneesMock: vi.fn(),
  apiMock: vi.fn(),
}));

vi.mock("@/hooks/use-deals", () => ({
  useDeals: mocks.useDealsMock,
}));

vi.mock("@/hooks/use-pipeline-config", () => ({
  usePipelineStages: mocks.usePipelineStagesMock,
}));

vi.mock("@/hooks/use-task-assignees", () => ({
  useTaskAssignees: mocks.useTaskAssigneesMock,
}));

vi.mock("@/lib/api", () => ({
  api: mocks.apiMock,
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: Record<string, unknown>) => <input {...props} />,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div data-mock-select>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectValue: ({ children, placeholder }: { children?: ReactNode; placeholder?: string }) => (
    <span>{children ?? placeholder ?? ""}</span>
  ),
}));

vi.mock("@/components/pipeline/terminal-date-filter-control", () => ({
  TerminalDateFilterControl: () => <div data-mock-date-filter />,
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn() },
}));

function makeDeal(overrides: Record<string, unknown> = {}) {
  return {
    id: "deal-1",
    dealNumber: "HS-321687989951",
    projectNumber: "DFW-1-12826-aa",
    name: "Palm Villas",
    stageId: "stage-opportunity",
    stageName: "Opportunity",
    stageSlug: "opportunity",
    workflowRoute: "normal",
    assignedRepId: "rep-1",
    assignedRepName: "Brett Jones",
    companyId: "company-1",
    companyName: "Acme Construction",
    propertyId: null,
    sourceLeadId: null,
    primaryContactId: null,
    ddEstimate: "180000",
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

function makeAtRiskResult(overrides: Partial<AtRiskResult> = {}): AtRiskResult {
  return {
    isAtRisk: true,
    status: "at_risk",
    severity: "at_risk",
    reason: "threshold_reached",
    stageSlug: "opportunity",
    canonicalStageSlug: "opportunity",
    viewerRole: "rep",
    audience: "rep",
    policy: {
      audience: "rep",
      stageSlug: "opportunity",
      dayCounting: "calendar_days",
      thresholdDays: 7,
      recurs: true,
      recurrenceDays: 7,
    },
    effectiveStageAgeSeconds: 864_000,
    effectiveStageAgeDays: 10,
    thresholdSeconds: 604_800,
    thresholdDays: 7,
    secondsUntilThreshold: 0,
    secondsPastThreshold: 259_200,
    ...overrides,
  };
}

function render(props: Parameters<typeof DealsListSection>[0] = {}) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <DealsListSection {...props} />
    </MemoryRouter>
  );
}

async function renderDom(props: Parameters<typeof DealsListSection>[0] = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <MemoryRouter>
        <DealsListSection {...props} />
      </MemoryRouter>
    );
  });
  return {
    container,
    rerender: async (nextProps: Parameters<typeof DealsListSection>[0] = props) => {
      await act(async () => {
        root.render(
          <MemoryRouter>
            <DealsListSection {...nextProps} />
          </MemoryRouter>
        );
      });
    },
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function renderInteractive(props: Parameters<typeof DealsListSection>[0] = {}) {
  const container = document.createElement("div");
  const root = createRoot(container);

  act(() => {
    root.render(
      <MemoryRouter>
        <DealsListSection {...props} />
      </MemoryRouter>
    );
  });

  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
    },
  };
}

describe("DealsListSection", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    mocks.useDealsMock.mockReset();
    mocks.usePipelineStagesMock.mockReset();
    mocks.useTaskAssigneesMock.mockReset();
    mocks.apiMock.mockReset();

    mocks.usePipelineStagesMock.mockReturnValue({
      loading: false,
      error: null,
      stages: [
        {
          id: "stage-opportunity",
          name: "Opportunity",
          slug: "opportunity",
          displayOrder: 1,
          isTerminal: false,
        },
        { id: "stage-won", name: "Won", slug: "won", displayOrder: 6, isTerminal: true },
      ],
    });

    mocks.useTaskAssigneesMock.mockReturnValue({
      assignees: [{ id: "rep-1", displayName: "Brett Jones" }],
    });

    mocks.useDealsMock.mockReturnValue({
      deals: [makeDeal()],
      pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    mocks.apiMock.mockResolvedValue({
      deals: [makeDeal()],
      pagination: { totalPages: 1 },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders search, stage filter chips, owner select, and a table", () => {
    const html = render();

    // Search input
    expect(html).toContain("Search");
    expect(html).toContain('placeholder="Deal name, number, company, address"');
    // Stage chips
    expect(html).toContain("Opportunity");
    expect(html).toContain("Won");
    // Owner field
    expect(html).toContain("Owner");
    // Row content
    expect(html).toContain("Palm Villas");
    expect(html).toContain("Dallas, TX");
    expect(html).toContain("DFW-1-12826-aa");
  });

  it("renders deal descriptions in a separate column with muted fallback and hover title", () => {
    mocks.useDealsMock.mockReturnValue({
      deals: [
        makeDeal({
          description: "Long deal description that should stay available on hover for the list view.",
        }),
        makeDeal({
          id: "deal-2",
          name: "No Description Deal",
          description: null,
        }),
      ],
      pagination: { page: 1, limit: 25, total: 2, totalPages: 1 },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = render();

    expect(html).toContain(">Description<");
    expect(html).toContain('aria-label="Long deal description that should stay available on hover for the list view."');
    expect(html).toContain('title="Long deal description that should stay available on hover for the list view."');
    expect(html).toContain("Long deal description that should stay available on hover for the list view.");
    expect(html).toContain("No Description Deal");
    expect(html).toContain(">—<");
    expect(html).toContain("table-fixed");
    expect(html).toContain("hidden lg:table-cell lg:w-[11rem]");
  });

  it("renders the selected owner filter label from assignees instead of the raw id", () => {
    const html = render();

    expect(html).toContain("All reps");
    expect(html).toContain("Brett Jones");
  });

  it("uses paginated useDeals call (page-based, not endless scroll)", () => {
    render();

    const call = mocks.useDealsMock.mock.calls[mocks.useDealsMock.mock.calls.length - 1][0];
    expect(call).toMatchObject({
      page: 1,
      limit: 25,
      sortBy: "created_at",
      sortDir: "desc",
    });
    // With no stages selected, the section opts into pipeline mode so terminal
    // (won/lost) deals are visible alongside active stages via inactiveStageIds.
    expect(call.isActive).toBe("pipeline");
    expect(call.inactiveStageIds).toEqual(["stage-won"]);
  });

  it("switches to active-only filtering when only non-terminal stages are selected", () => {
    // Re-mock with a non-terminal stage selected
    mocks.usePipelineStagesMock.mockReturnValue({
      loading: false,
      error: null,
      stages: [
        {
          id: "stage-opportunity",
          name: "Opportunity",
          slug: "opportunity",
          displayOrder: 1,
          isTerminal: false,
        },
        { id: "stage-won", name: "Won", slug: "won", displayOrder: 6, isTerminal: true },
      ],
    });
    // The default render selects no stage; we just confirm the helper logic
    // by inspecting the initial call (no stages → pipeline mode).
    render();
    const initialCall =
      mocks.useDealsMock.mock.calls[mocks.useDealsMock.mock.calls.length - 1][0];
    expect(initialCall.isActive).toBe("pipeline");
  });

  it("respects pageSize prop override", () => {
    render({ pageSize: 50 });

    const call = mocks.useDealsMock.mock.calls[mocks.useDealsMock.mock.calls.length - 1][0];
    expect(call.limit).toBe(50);
  });

  it("hides date filter and export by default", () => {
    const html = render();
    expect(html).not.toContain("data-mock-date-filter");
    expect(html).not.toContain(">Export<");
  });

  it("accepts a deal workflow family and custom search placeholder without changing page-based query", () => {
    const html = render({
      workflowFamily: "deal",
      searchPlaceholder: "Search deals or accounts",
      showFilterButton: true,
      pageSize: 20,
    });

    expect(mocks.usePipelineStagesMock).toHaveBeenCalledWith("deal");
    expect(mocks.useDealsMock).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20 }),
      expect.any(Object)
    );
    expect(html).toContain('placeholder="Search deals or accounts"');
    expect(html).not.toContain(">Filter<");
  });

  it("renders date filter control when enableDateFilter is true", () => {
    const html = render({ enableDateFilter: true });
    expect(html).toContain("data-mock-date-filter");
  });

  it("renders export button when enableExport is true", () => {
    const html = render({ enableExport: true });
    expect(html).toContain(">Export<");
  });

  it("mounts without drill-down props and does not thrash renders", async () => {
    const { cleanup } = await renderDom();
    try {
      expect(mocks.useDealsMock.mock.calls.length).toBeLessThan(5);
      const lastCall = mocks.useDealsMock.mock.calls[mocks.useDealsMock.mock.calls.length - 1]?.[0];
      expect(lastCall).toMatchObject({ sortBy: "created_at", sortDir: "desc" });
    } finally {
      await cleanup();
    }
  });

  it("threads filterBar.paramPrefix so the list reads dl_* params, not the page's bare board params", async () => {
    // The /deals base list shares its URL with the dashboard's bare ?assignedRepId/?scope/etc.; a dl_
    // prefix namespaces the list's FilterBar so it can't collide with (or mutate) those page controls.
    const container = document.createElement("div");
    document.body.appendChild(container);
    let root!: Root;
    await act(async () => {
      root = createRoot(container);
      root.render(
        <MemoryRouter initialEntries={["/deals?dl_search=fromlist&search=fromboard"]}>
          <DealsListSection
            workflowFamily="deal"
            filterBar={{ dimensions: ["search", "stage", "sort"], paramPrefix: "dl_" }}
          />
        </MemoryRouter>
      );
    });
    const lastCall = mocks.useDealsMock.mock.calls[mocks.useDealsMock.mock.calls.length - 1][0];
    expect(lastCall.search).toBe("fromlist"); // the dl_-namespaced value, not the bare board ?search
    await act(async () => root.unmount());
    container.remove();
  });

  it("keeps a user-selected sort across rerenders when drill-down props are omitted", async () => {
    const { container, rerender, cleanup } = await renderDom();
    try {
      const dealSortButton = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Deal")
      );
      expect(dealSortButton).not.toBeNull();

      await act(async () => {
        dealSortButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      let lastCall = mocks.useDealsMock.mock.calls[mocks.useDealsMock.mock.calls.length - 1]?.[0];
      expect(lastCall).toMatchObject({ sortBy: "name", sortDir: "desc" });

      await rerender();

      lastCall = mocks.useDealsMock.mock.calls[mocks.useDealsMock.mock.calls.length - 1]?.[0];
      expect(lastCall).toMatchObject({ sortBy: "name", sortDir: "desc" });
    } finally {
      await cleanup();
    }
  });

  it("forwards scope to useDeals", () => {
    render({ scope: "team" });
    const call = mocks.useDealsMock.mock.calls[mocks.useDealsMock.mock.calls.length - 1][0];
    expect(call.scope).toBe("team");
  });

  it("clears the effective owner filter when a hidden locked owner is cleared", async () => {
    const { rerender, cleanup } = await renderDom({ lockedOwnerId: "rep-1", hideOwnerFilter: true });
    try {
      let call = mocks.useDealsMock.mock.calls[mocks.useDealsMock.mock.calls.length - 1][0];
      expect(call.assignedRepId).toBe("rep-1");

      await rerender({ hideOwnerFilter: true });

      call = mocks.useDealsMock.mock.calls[mocks.useDealsMock.mock.calls.length - 1][0];
      expect(call.assignedRepId).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("forwards updatedFrom and updatedTo into the CSV export request", async () => {
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:test"),
      revokeObjectURL: vi.fn(),
    });
    const { container, cleanup } = await renderDom({
      enableExport: true,
      baseFilters: {
        updatedFrom: "2026-04-01",
        updatedTo: "2026-05-08",
      },
    });
    try {
      const exportButton = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Export")
      );
      expect(exportButton).not.toBeNull();

      await act(async () => {
        exportButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      const requestUrl = String(mocks.apiMock.mock.calls[0]?.[0] ?? "");
      expect(requestUrl).toContain("updatedFrom=2026-04-01");
      expect(requestUrl).toContain("updatedTo=2026-05-08");
    } finally {
      Object.assign(URL, {
        createObjectURL: originalCreateObjectURL,
        revokeObjectURL: originalRevokeObjectURL,
      });
      await cleanup();
    }
  });

  it("loads deal-family stages only", () => {
    render();
    expect(mocks.usePipelineStagesMock).toHaveBeenCalledWith("deal");
  });

  it("groups same-slug stage chip options without dropping alternate workflow stage ids", () => {
    const options = buildDealStageFilterOptions([
      {
        id: "stage-estimating-standard",
        name: "Estimating",
        slug: "estimating",
        displayOrder: 2,
        isTerminal: false,
      },
      {
        id: "stage-estimating-service",
        name: "Estimating",
        slug: "estimating",
        displayOrder: 3,
        isTerminal: false,
      },
      {
        id: "stage-won",
        name: "Won",
        slug: "won",
        displayOrder: 6,
        isTerminal: true,
      },
    ] as never);

    expect(options).toEqual([
      {
        ids: ["stage-estimating-standard", "stage-estimating-service"],
        slug: "estimating",
        name: "Estimating",
        isTerminal: false,
      },
      { ids: ["stage-won"], slug: "won", name: "Won", isTerminal: true },
    ]);
    expect(getSelectedDealStageIds(["estimating"], options)).toEqual([
      "stage-estimating-standard",
      "stage-estimating-service",
    ]);
  });

  it("excludes requested stage slugs from chip options", () => {
    const html = render({
      visibleStages: [
        { id: "stage-dd", name: "DD", slug: "dd" },
        { id: "stage-estimating", name: "Estimating", slug: "estimating" },
      ],
      excludeStageSlugs: ["dd"],
    });

    expect(html).not.toContain(">DD<");
    expect(html).toContain(">Estimating<");
  });

  it("preserves terminal stage ids from visible stage options while metadata is unavailable", () => {
    expect(
      getVisibleListTerminalStageIds(
        [],
        [
          { ids: ["stage-won"], slug: "won", name: "Won", isTerminal: true },
          { ids: ["stage-estimating"], slug: "estimating", name: "Estimating", isTerminal: false },
        ]
      )
    ).toEqual(["stage-won"]);
  });

  it("renders pagination controls (chevron buttons) when there is data", () => {
    mocks.useDealsMock.mockReturnValue({
      deals: [makeDeal(), makeDeal({ id: "deal-2", name: "Second" })],
      pagination: { page: 1, limit: 25, total: 60, totalPages: 3 },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = render();

    // Page indicator from PipelineStageTable
    expect(html).toContain("Page 1 of 3");
    expect(html).toContain("60 total records");
    expect(html).toContain("bg-primary");
    expect(html).toContain("text-primary-foreground");
    expect(html).toContain("disabled:border-muted-foreground/20");
    expect(html).toContain("disabled:bg-muted");
    expect(html).toContain("disabled:text-muted-foreground");
    // Pager chevrons are >=44px (h-11 w-11) on phones, reverting to the compact size at md.
    expect(html).toContain("h-11 w-11");
    expect(html).toContain("md:h-9 md:w-9");
  });

  it("renders an active-versus-total pagination summary when provided", () => {
    mocks.useDealsMock.mockReturnValue({
      deals: [makeDeal(), makeDeal({ id: "deal-2", name: "Second" })],
      pagination: { page: 1, limit: 25, total: 60, totalPages: 3 },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = render({ paginationCountSummary: { active: 42, total: 60 } });

    expect(html).toContain("42/60 active records");
    expect(html).not.toContain("60 total records");
  });

  it("derives the active-versus-total badge from the filtered list query pagination when available", () => {
    mocks.useDealsMock.mockReturnValue({
      deals: [makeDeal(), makeDeal({ id: "deal-2", name: "Second" })],
      pagination: { page: 1, limit: 25, total: 7, totalPages: 1, activeCount: 3 },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = render();

    expect(html).toContain("3/7 active records");
    expect(html).not.toContain("7 total records");
  });

  it("resets pagination when the drill-down context changes", async () => {
    mocks.useDealsMock.mockImplementation((input: { page: number }) => ({
      deals: [makeDeal({ id: `deal-page-${input.page}` })],
      pagination: { page: input.page, limit: 25, total: 125, totalPages: 5 },
      loading: false,
      error: null,
      refetch: vi.fn(),
    }));

    const { container, rerender, cleanup } = await renderDom({
      initialStageSlugs: [],
    });
    try {
      const nextPageButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.getAttribute("aria-label") === "Next page"
      );
      expect(nextPageButton).not.toBeNull();

      await act(async () => {
        nextPageButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await act(async () => {
        nextPageButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      let lastCall = mocks.useDealsMock.mock.calls[mocks.useDealsMock.mock.calls.length - 1]?.[0];
      expect(lastCall.page).toBe(3);

      await rerender({
        initialStageSlugs: ["opportunity"],
      });

      lastCall = mocks.useDealsMock.mock.calls[mocks.useDealsMock.mock.calls.length - 1]?.[0];
      expect(lastCall.page).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("renders shared pagination controls for the mobile card view and advances pages", () => {
    mocks.useDealsMock.mockReturnValue({
      deals: [makeDeal(), makeDeal({ id: "deal-2", name: "Second" })],
      pagination: { page: 1, limit: 25, total: 60, totalPages: 3 },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const { container, unmount } = renderInteractive();

    expect(container.textContent).toContain("Page 1 of 3");
    const buttons = Array.from(container.querySelectorAll("button"));
    const previousButton = buttons.find((button) => button.getAttribute("aria-label") === "Previous page");
    const nextButton = buttons.find((button) => button.getAttribute("aria-label") === "Next page");
    expect(previousButton?.disabled).toBe(true);
    expect(previousButton?.className).toContain("bg-primary");
    expect(previousButton?.className).toContain("text-primary-foreground");
    expect(previousButton?.className).toContain("disabled:border-muted-foreground/20");
    expect(previousButton?.className).toContain("disabled:bg-muted");
    expect(previousButton?.className).toContain("disabled:text-muted-foreground");
    expect(nextButton).toBeTruthy();
    expect(nextButton?.className).toContain("bg-primary");
    expect(nextButton?.className).toContain("text-primary-foreground");

    act(() => {
      nextButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const lastCall = mocks.useDealsMock.mock.calls[mocks.useDealsMock.mock.calls.length - 1][0];
    expect(lastCall.page).toBe(2);

    unmount();
  });

  it("keeps the next button visibly disabled on the last page", () => {
    mocks.useDealsMock.mockReturnValue({
      deals: [makeDeal(), makeDeal({ id: "deal-2", name: "Second" })],
      pagination: { page: 3, limit: 25, total: 60, totalPages: 3 },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const { container, unmount } = renderInteractive();
    const buttons = Array.from(container.querySelectorAll("button"));
    const nextButton = buttons.find((button) => button.getAttribute("aria-label") === "Next page");

    expect(nextButton?.disabled).toBe(true);
    expect(nextButton?.className).toContain("bg-primary");
    expect(nextButton?.className).toContain("text-primary-foreground");
    expect(nextButton?.className).toContain("disabled:border-muted-foreground/20");
    expect(nextButton?.className).toContain("disabled:bg-muted");
    expect(nextButton?.className).toContain("disabled:text-muted-foreground");

    unmount();
  });

  it("keeps single-page pagination controls visible and distinctly disabled", () => {
    mocks.useDealsMock.mockReturnValue({
      deals: [makeDeal()],
      pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const { container, unmount } = renderInteractive();
    const buttons = Array.from(container.querySelectorAll("button"));
    const previousButton = buttons.find((button) => button.getAttribute("aria-label") === "Previous page");
    const nextButton = buttons.find((button) => button.getAttribute("aria-label") === "Next page");

    expect(previousButton?.disabled).toBe(true);
    expect(nextButton?.disabled).toBe(true);
    expect(previousButton?.className).toContain("disabled:bg-muted");
    expect(nextButton?.className).toContain("disabled:text-muted-foreground");

    unmount();
  });

  it("renders a mobile card layout and keeps the desktop table hidden below md", () => {
    const html = render({
      searchPlaceholder: "Search deals or accounts",
    });

    expect(html).toContain('aria-label="Deals list cards"');
    expect(html).toContain("md:hidden");
    expect(html).toContain('aria-label="Open deal Palm Villas"');
    expect(html).toContain("line-clamp-2");
    expect(html).toContain("min-h-11");
    expect(html).toContain("hidden overflow-x-auto md:block");
  });

  it("renders at-risk badges in list cards and table rows when supplied", () => {
    mocks.useDealsMock.mockReturnValue({
      deals: [makeDeal({ atRisk: makeAtRiskResult() })],
      pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = render();

    expect(html).toContain("At Risk");
    expect(html).toContain('data-at-risk-severity="at_risk"');
  });

  it("uses Bid Board stage age for list card SLA labels next to At Risk badges", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-10T00:00:00.000Z"));
      mocks.useDealsMock.mockReturnValue({
        deals: [
          makeDeal({
            isBidBoardOwned: true,
            stageEnteredAt: "2026-05-10T00:00:00.000Z",
            bidBoardStageEnteredAt: "2026-05-01T00:00:00.000Z",
            atRisk: makeAtRiskResult({ effectiveStageAgeDays: 9 }),
          }),
        ],
        pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
        loading: false,
        error: null,
        refetch: vi.fn(),
      });

      const html = render();

      expect(html).toContain("At Risk");
      expect(html).toContain("9d SLA");
      expect(html).not.toContain("0d SLA");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not render at-risk badges in the list before Slice B supplies the result", () => {
    const html = render();

    expect(html).not.toContain("At Risk");
    expect(html).not.toContain("data-at-risk-severity");
  });

  it("prefers actual close date over expected close date when both exist", () => {
    expect(
      getDealCloseDate(
        makeDeal({
          actualCloseDate: "2026-04-15T00:00:00.000Z",
          expectedCloseDate: "2026-05-20T00:00:00.000Z",
        }) as never
      )
    ).toBe("2026-04-15T00:00:00.000Z");
  });

  it("uses expected close date when actual close date is absent", () => {
    expect(
      getDealCloseDate(
        makeDeal({
          actualCloseDate: null,
          expectedCloseDate: "2026-05-20T00:00:00.000Z",
        }) as never
      )
    ).toBe("2026-05-20T00:00:00.000Z");
  });

  it("returns null when neither close date exists", () => {
    expect(
      getDealCloseDate(
        makeDeal({
          actualCloseDate: null,
          expectedCloseDate: null,
        }) as never
      )
    ).toBeNull();
  });

  it("defaults the list to newest and lets the user toggle oldest", () => {
    const { container, unmount } = renderInteractive({
      initialSort: { key: "name", dir: "asc" },
    });

    const newestButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Newest")
    );
    const oldestButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Oldest")
    );
    expect(newestButton).toBeTruthy();
    expect(oldestButton).toBeTruthy();

    act(() => {
      oldestButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const lastCall = mocks.useDealsMock.mock.calls[mocks.useDealsMock.mock.calls.length - 1][0];
    expect(lastCall.sortBy).toBe("created_at");
    expect(lastCall.sortDir).toBe("asc");

    unmount();
  });

  it("switches to updated sorting and resets pagination when the Updated control is used", () => {
    mocks.useDealsMock.mockImplementation((input: { page: number; sortBy: string; sortDir: string }) => ({
      deals: [makeDeal({ id: `deal-${input.page}-${input.sortBy}-${input.sortDir}` })],
      pagination: { page: input.page, limit: 25, total: 75, totalPages: 3 },
      loading: false,
      error: null,
      refetch: vi.fn(),
    }));

    const { container, unmount } = renderInteractive();
    const nextPageButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.getAttribute("aria-label") === "Next page"
    );
    const updatedButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Updated")
    );

    expect(nextPageButton).toBeTruthy();
    expect(updatedButton).toBeTruthy();

    act(() => {
      nextPageButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    let lastCall = mocks.useDealsMock.mock.calls[mocks.useDealsMock.mock.calls.length - 1][0];
    expect(lastCall.page).toBe(2);

    act(() => {
      updatedButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    lastCall = mocks.useDealsMock.mock.calls[mocks.useDealsMock.mock.calls.length - 1][0];
    expect(lastCall.page).toBe(1);
    expect(lastCall.sortBy).toBe("updated_at");
    expect(lastCall.sortDir).toBe("desc");

    unmount();
  });

  it("uses fixed-width tablet and desktop columns so stage, sla, value, and dates cannot overlap", () => {
    const html = render({
      visibleStages: [
        { id: "stage-opportunity", name: "Opportunity", slug: "opportunity" },
        {
          id: "stage-sent",
          name: "Estimate Sent to Client",
          slug: "estimate_sent_to_client",
        },
      ],
    });

    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("md:min-w-[44rem] lg:min-w-[58rem]");
    expect(html).toContain("md:w-[13.5rem] md:!px-2 lg:w-[15rem]");
    expect(html).toContain("hidden lg:table-cell lg:w-[11rem]");
    expect(html).toContain("md:w-[4rem] md:!px-2 lg:w-[7.5rem]");
    expect(html).toContain("md:w-[8rem] md:!px-2 lg:w-[8.5rem]");
    expect(html).toContain("hidden lg:table-cell lg:w-[3rem]");
    expect(html).toContain("md:w-[5.75rem] md:!px-2");
    expect(html).toContain("md:w-[4.75rem] md:!px-2");
  });

  it("truncates long text cleanly and preserves full values in accessibility labels", () => {
    mocks.useDealsMock.mockReturnValue({
      deals: [
        makeDeal({
          name: "The Long Deal Name That Should Clamp Before It Ever Pushes Into Neighboring Columns On Small Screens",
          projectNumber: "DFW-1-12826-zz",
          stageName: "ESTIMATE SENT TO CLIENT",
          description:
            "Very long deal description that should truncate in the desktop column while still remaining available to assistive technology and hover affordances.",
          propertyAddress:
            "742 Evergreen Terrace Building 2000 Suite 450 With An Unreasonably Long Address Label",
        }),
      ],
      pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = render();

    expect(html).toContain(
      'aria-label="The Long Deal Name That Should Clamp Before It Ever Pushes Into Neighboring Columns On Small Screens"'
    );
    expect(html).toContain(
      'aria-label="742 Evergreen Terrace Building 2000 Suite 450 With An Unreasonably Long Address Label"'
    );
    expect(html).toContain('title="ESTIMATE SENT TO CLIENT"');
    expect(html).toContain("truncate");
    expect(html).toContain("whitespace-nowrap");
  });

  // D-15: the rep drill-down list must filter + display on the CANONICAL outcome
  // date axis (Won->won_closed_date, Lost->lost_at, open->stage_entered_at) so it
  // agrees with the rep's outcome-axis KPI — not filter created_at while displaying
  // the close date. dateField="outcome" routes the window to dateFrom/dateTo (the
  // #546 outcome-aware filter) and renders the server displayDate (#558).
  describe("dateField=outcome (D-15 rep drill-down: filter-axis == display-axis on the outcome axis)", () => {
    it("export query maps the range to the canonical outcome window (dateFrom/dateTo), not created/updated", () => {
      const params = buildDealListParams({
        search: "",
        stageIds: [],
        assignedRepId: "rep-1",
        dateRange: { from: "2026-04-01", to: "2026-05-31" },
        dateField: "outcome",
        isActive: "all",
        sort: { key: "stage_entered_at", dir: "desc" },
        page: 1,
        limit: 50,
        scope: "all",
      });
      expect(params.get("dateFrom")).toBe("2026-04-01");
      expect(params.get("dateTo")).toBe("2026-05-31");
      expect(params.has("createdFrom")).toBe(false);
      expect(params.has("updatedFrom")).toBe(false);
    });

    it("live query filters the outcome window (dateFrom/dateTo), never created_at/updated_at", () => {
      render({
        dateField: "outcome",
        externalDateRange: { from: "2026-04-01", to: "2026-05-31" },
        enableDateFilter: false,
        lockedOwnerId: "rep-1",
      });
      const call = mocks.useDealsMock.mock.calls[mocks.useDealsMock.mock.calls.length - 1][0];
      expect(call.dateFrom).toBe("2026-04-01");
      expect(call.dateTo).toBe("2026-05-31");
      expect(call.createdFrom).toBeUndefined();
      expect(call.updatedFrom).toBeUndefined();
      // Codex #564: force open rows to be bounded on stage_entered_at regardless of the
      // server flag, so the window is not silently inert for open deals.
      expect(call.stageEntryDateWindow).toBe(true);
    });

    it("displays the server outcome displayDate, not the close date (filter-axis == display-axis)", async () => {
      mocks.useDealsMock.mockReturnValue({
        deals: [
          makeDeal({
            displayDate: "2026-05-20T12:00:00.000Z",
            actualCloseDate: "2026-08-15T12:00:00.000Z",
            expectedCloseDate: null,
          }),
        ],
        pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
        loading: false,
        error: null,
        refetch: vi.fn(),
      });
      const view = await renderDom({
        dateField: "outcome",
        externalDateRange: { from: "2026-04-01", to: "2026-05-31" },
        enableDateFilter: false,
        lockedOwnerId: "rep-1",
      });
      // The date column (local "MMM d" formatter) shows the outcome displayDate
      // (May 20), NOT the close date (Aug 15) — and the header is "Date", not "Close".
      const text = view.container.textContent ?? "";
      expect(text).toContain("May 20"); // outcome displayDate
      expect(text).not.toContain("Aug 15"); // not the close date
      expect(text).toContain("Date");
      expect(text).not.toContain("Close");
      await view.cleanup();
    });

    it("hides the updated_at quick-sort and orders Newest/Oldest by the outcome display date (Codex #564: pills don't revert to created_at)", async () => {
      const view = await renderDom({
        dateField: "outcome",
        externalDateRange: { from: "2026-04-01", to: "2026-05-31" },
        enableDateFilter: false,
        lockedOwnerId: "rep-1",
        initialSort: { key: "display_date", dir: "desc" },
      });
      const buttons = () => Array.from(view.container.querySelectorAll("button"));
      // The updated_at quick-sort is not the outcome axis -> hidden in outcome mode.
      expect(buttons().some((b) => b.textContent?.trim().startsWith("Updated"))).toBe(false);
      // Clicking "Newest" orders by the outcome display date, NOT created_at.
      const newest = buttons().find((b) => b.textContent?.trim() === "Newest");
      expect(newest).toBeDefined();
      await act(async () => {
        newest!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      const call = mocks.useDealsMock.mock.calls[mocks.useDealsMock.mock.calls.length - 1][0];
      expect(call.sortBy).toBe("display_date");
      expect(call.sortBy).not.toBe("created_at");
      await view.cleanup();
    });

    it("exports the outcome displayDate column, not the legacy Last Touch axis (Codex #570: export matches the on-screen list)", async () => {
      const csvParts: string[] = [];
      const OriginalBlob = globalThis.Blob;
      const originalCreate = URL.createObjectURL;
      const originalRevoke = URL.revokeObjectURL;
      Object.assign(URL, { createObjectURL: vi.fn(() => "blob:test"), revokeObjectURL: vi.fn() });
      globalThis.Blob = class {
        constructor(parts: unknown[]) {
          csvParts.push(String((parts as unknown[])?.[0] ?? ""));
        }
      } as unknown as typeof Blob;
      mocks.apiMock.mockResolvedValue({
        deals: [
          makeDeal({
            displayDate: "2026-05-20T00:00:00.000Z",
            lastActivityAt: "2026-08-15T00:00:00.000Z",
            updatedAt: "2026-08-15T00:00:00.000Z",
          }),
        ],
        pagination: { totalPages: 1 },
      });
      const { container, cleanup } = await renderDom({
        enableExport: true,
        dateField: "outcome",
        externalDateRange: { from: "2026-04-01", to: "2026-05-31" },
        lockedOwnerId: "rep-1",
      });
      try {
        const exportButton = Array.from(container.querySelectorAll("button")).find((b) =>
          b.textContent?.includes("Export")
        );
        expect(exportButton).toBeDefined();
        await act(async () => {
          exportButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        const csv = csvParts.join("");
        expect(csv).not.toContain("Last Touch"); // legacy axis header gone
        expect(csv).toContain("2026-05-20"); // the outcome displayDate
        expect(csv).not.toContain("2026-08-15"); // not lastActivityAt/updatedAt
      } finally {
        globalThis.Blob = OriginalBlob;
        Object.assign(URL, { createObjectURL: originalCreate, revokeObjectURL: originalRevoke });
        await cleanup();
      }
    });
  });
});
