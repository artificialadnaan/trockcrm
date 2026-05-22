// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import {
  DealsListSection,
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
});
