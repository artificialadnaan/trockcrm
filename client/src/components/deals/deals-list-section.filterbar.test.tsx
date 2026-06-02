// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useSearchParams } from "react-router-dom";
import { DealsListSection, shouldResetNamespacedPage } from "./deals-list-section";
import type { FilterDimension, FilterBarOptions } from "@/components/filters/filter-bar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  useDealsMock: vi.fn(),
  usePipelineStagesMock: vi.fn(),
  useTaskAssigneesMock: vi.fn(),
  apiMock: vi.fn(),
}));

vi.mock("@/hooks/use-deals", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-deals")>();
  return { ...actual, useDeals: mocks.useDealsMock };
});
vi.mock("@/hooks/use-pipeline-config", () => ({ usePipelineStages: mocks.usePipelineStagesMock }));
vi.mock("@/hooks/use-task-assignees", () => ({ useTaskAssignees: mocks.useTaskAssigneesMock }));
vi.mock("@/lib/api", () => ({ api: mocks.apiMock }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn() } }));

function makeDeal(overrides: Record<string, unknown> = {}) {
  return {
    id: "deal-1",
    dealNumber: "HS-1",
    projectNumber: "DFW-1",
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

const FB_DIMENSIONS: FilterDimension[] = [
  "search",
  "date",
  "stage",
  "rep",
  "status",
  "workflow",
  "region",
  "projectType",
  "value",
  "sort",
  // stalled is part of an outcome-aware mount's row (DEAL_LIST_FILTERBAR_DIMENSIONS); include it so the
  // dimension-scoped param pick honors minAgeDays/maxAgeDays the way the real pipeline/drill-down bars do.
  "stalled",
];
const FB_OPTIONS: FilterBarOptions = {
  reps: [{ value: "rep-1", label: "Brett Jones" }],
  regions: [{ value: "region-1", label: "DFW" }],
  projectTypes: [{ value: "type-1", label: "Multifamily" }],
  stages: [
    { value: "stage-opportunity", label: "Opportunity" },
    { value: "stage-won", label: "Won" },
  ],
  sortOptions: [
    { label: "Newest", sortBy: "created_at", sortDir: "desc" },
    { label: "Value", sortBy: "awarded_amount", sortDir: "desc" },
  ],
};
const FB_PROP = { dimensions: FB_DIMENSIONS, options: FB_OPTIONS, stageEntryDateEnabled: false };
// The pipeline mount mirrors the board: the visible columns are the default stage scope, and the
// terminal subset flows through as inactive stages (Slice 7 design sign-off — Q1 + Q2).
const FB_PROP_BOARD = {
  ...FB_PROP,
  defaultStageIds: ["stage-opportunity", "stage-won"],
  terminalStageIds: ["stage-won"],
};
// An outcome-aware mount (the pipeline list post-flag-flip): the bar drops the honest "current state"
// note and presents Date as outcome-aware + shows Stalled, so the mount must force stage_entry_window.
const FB_PROP_OUTCOME = { ...FB_PROP, stageEntryDateEnabled: true };

const lastDealsCall = () => mocks.useDealsMock.mock.calls[mocks.useDealsMock.mock.calls.length - 1][0];

// Capture the live URL search string so tests can assert what the FilterBar writes/preserves.
let currentSearch = "";
function LocationSpy() {
  const [params] = useSearchParams();
  currentSearch = params.toString();
  return null;
}

let container: HTMLDivElement;
let root: Root | null;

async function renderFB(
  url: string,
  extraProps: Parameters<typeof DealsListSection>[0] = {},
  filterBar: NonNullable<Parameters<typeof DealsListSection>[0]["filterBar"]> = FB_PROP
) {
  currentSearch = "";
  await act(async () => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={[url]}>
        <LocationSpy />
        <DealsListSection filterBar={filterBar} {...extraProps} />
      </MemoryRouter>
    );
  });
}

describe("DealsListSection — FilterBar (URL) mode (Slice 7 proving ground)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    mocks.useDealsMock.mockReset();
    mocks.usePipelineStagesMock.mockReset();
    mocks.useTaskAssigneesMock.mockReset();
    mocks.apiMock.mockReset();

    mocks.usePipelineStagesMock.mockReturnValue({
      loading: false,
      error: null,
      stages: [
        { id: "stage-opportunity", name: "Opportunity", slug: "opportunity", displayOrder: 1, isTerminal: false },
        { id: "stage-won", name: "Won", slug: "won", displayOrder: 6, isTerminal: true },
      ],
    });
    mocks.useTaskAssigneesMock.mockReturnValue({ assignees: [{ id: "rep-1", displayName: "Brett Jones" }] });
    mocks.useDealsMock.mockReturnValue({
      deals: [makeDeal()],
      pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mocks.apiMock.mockResolvedValue({ deals: [makeDeal()], pagination: { totalPages: 1 } });
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    container.remove();
    vi.restoreAllMocks();
  });

  it("maps URL filters to useDeals: outcome-aware date window + status, never the legacy isActive", async () => {
    await renderFB(
      "/deals?status=on_hold&dateFrom=2026-05-01&dateTo=2026-05-27&assignedRepId=rep-1&stageIds=stage-opportunity&sortBy=created_at&sortDir=desc"
    );
    const call = lastDealsCall();
    expect(call).toMatchObject({
      status: "on_hold",
      dateFrom: "2026-05-01",
      dateTo: "2026-05-27",
      assignedRepId: "rep-1",
      stageIds: ["stage-opportunity"],
      sortBy: "created_at",
      sortDir: "desc",
    });
    expect(call.isActive).toBeUndefined();
    expect(call.inactiveStageIds).toBeUndefined();
  });

  it("forwards the __unassigned__ rep sentinel verbatim", async () => {
    await renderFB("/deals?assignedRepId=__unassigned__");
    expect(lastDealsCall().assignedRepId).toBe("__unassigned__");
  });

  // Codex #580 (rollback-safety): when the mount is outcome-aware (stageEntryDateEnabled — the bar hides
  // the "current state" note and claims the Date axis is outcome-aware), every date/age filter must bound
  // open rows regardless of ENABLE_STAGE_ENTRY_DATE_FILTER. The server only windows open rows when the env
  // flag OR filters.stageEntryDateWindow is true, so the mount forces the override (keyed off the prop, not
  // the env flag, so it survives a flag rollback). Tied to the prop so a current-state mount stays honest.
  it("forces stage_entry_window for a date-only filter when the mount is outcome-aware", async () => {
    await renderFB("/deals?dateFrom=2026-05-01&dateTo=2026-05-27", {}, FB_PROP_OUTCOME);
    const call = lastDealsCall();
    expect(call.dateFrom).toBe("2026-05-01");
    expect(call.stageEntryDateWindow).toBe(true);
  });

  it("forces stage_entry_window for a Stalled (age) filter when the mount is outcome-aware", async () => {
    await renderFB("/deals?minAgeDays=30", {}, FB_PROP_OUTCOME);
    const call = lastDealsCall();
    expect(call.minAgeDays).toBe(30);
    expect(call.stageEntryDateWindow).toBe(true);
  });

  it("does NOT force stage_entry_window on a current-state mount (stageEntryDateEnabled=false) — open rows stay honestly un-windowed", async () => {
    await renderFB("/deals?dateFrom=2026-05-01&dateTo=2026-05-27", {}, FB_PROP);
    const call = lastDealsCall();
    expect(call.dateFrom).toBe("2026-05-01");
    expect(call.stageEntryDateWindow).toBeFalsy();
  });

  it("renders the shared FilterBar and drops the legacy inline owner/stage-chip/sort controls", async () => {
    await renderFB("/deals");
    expect(container.querySelector('[role="group"][aria-label="Filters"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Clear filters"]')).not.toBeNull();
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.find((b) => b.textContent?.trim() === "Newest")).toBeUndefined();
    expect(buttons.find((b) => b.textContent?.trim() === "Updated")).toBeUndefined();
  });

  it("renders the server displayDate in the date column (filter-axis == display-axis)", async () => {
    mocks.useDealsMock.mockReturnValue({
      deals: [makeDeal({ displayDate: "2026-05-20", actualCloseDate: "2026-08-15", expectedCloseDate: null })],
      pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    await renderFB("/deals");
    expect(container.textContent).toContain("May");
    expect(container.textContent).not.toContain("Aug");
  });

  it("falls back to the close date when the server has not yet provided displayDate (pre-P0)", async () => {
    mocks.useDealsMock.mockReturnValue({
      deals: [makeDeal({ actualCloseDate: "2026-08-15", expectedCloseDate: null })],
      pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    await renderFB("/deals");
    expect(container.textContent).toContain("Aug");
  });

  it("advancing the page writes ?page to the URL and refetches that page", async () => {
    mocks.useDealsMock.mockImplementation((input: { page?: number }) => ({
      deals: [makeDeal()],
      pagination: { page: input.page ?? 1, limit: 25, total: 60, totalPages: 3 },
      loading: false,
      error: null,
      refetch: vi.fn(),
    }));
    await renderFB("/deals");
    const nextButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "Next page"
    );
    expect(nextButton).toBeTruthy();
    await act(async () => {
      nextButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(lastDealsCall().page).toBe(2);
  });

  it("inherits the page-level scope when the URL carries none", async () => {
    await renderFB("/deals", { scope: "all" });
    expect(lastDealsCall().scope).toBe("all");
  });

  it("ignores a bookmarked ?scope=team and uses the page's normalized scope — the list must not disagree with the board (Codex)", async () => {
    // PipelinePage coerces ?scope=team -> mine for the board (Team retired) and passes the normalized
    // scope PROP. This mount renders no scope control, so the list must NOT read the raw URL scope —
    // else it fetches team-scoped rows while the board + toggle show Mine.
    await renderFB("/deals?scope=team", { scope: "mine" }, FB_PROP_BOARD);
    expect(lastDealsCall().scope).toBe("mine");
  });

  it("does read scope from the URL when the bar OWNS the scope dimension (other surfaces)", async () => {
    await renderFB("/deals?scope=all", { scope: "mine" }, {
      ...FB_PROP_BOARD,
      dimensions: [...FB_DIMENSIONS, "scope"],
    });
    expect(lastDealsCall().scope).toBe("all");
  });

  it("Q2: a stale DD stageId left in the URL is dropped once the board hides DD (Codex)", async () => {
    // FB_PROP_BOARD's visible columns are stage-opportunity + stage-won (DD hidden). A bookmarked URL
    // still carries the DD selection; the list must not keep querying the now-hidden DD stage.
    await renderFB("/deals?stageIds=stage-dd,stage-opportunity", {}, FB_PROP_BOARD);
    expect(lastDealsCall().stageIds).toEqual(["stage-opportunity"]);
  });

  it("routes table-header sorts through the URL (not dead local state) in FilterBar mode", async () => {
    await renderFB("/deals?sortBy=created_at&sortDir=desc");
    const dealHeader = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Deal"));
    expect(dealHeader).toBeTruthy();
    await act(async () => {
      dealHeader?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(lastDealsCall()).toMatchObject({ sortBy: "name", sortDir: "desc" });
  });

  it("Q1: mirrors the board — with no Status chosen, sends mixed visibility so terminal deals show", async () => {
    await renderFB("/deals", {}, FB_PROP_BOARD);
    const call = lastDealsCall();
    expect(call.isActive).toBe("pipeline");
    expect(call.inactiveStageIds).toEqual(["stage-won"]);
    // Q2: defaults to the board's visible columns when the user has picked no stages
    expect(call.stageIds).toEqual(["stage-opportunity", "stage-won"]);
  });

  it("Q1: an explicit Status wins — isActive is not forced, the chosen lifecycle owns visibility", async () => {
    await renderFB("/deals?status=active", {}, FB_PROP_BOARD);
    const call = lastDealsCall();
    expect(call.status).toBe("active");
    expect(call.isActive).toBeUndefined();
    expect(call.inactiveStageIds).toBeUndefined();
    expect(call.stageIds).toEqual(["stage-opportunity", "stage-won"]); // stage scope still mirrors the board
  });

  it("Q2: an explicit stage selection overrides the board default", async () => {
    await renderFB("/deals?stageIds=stage-opportunity", {}, FB_PROP_BOARD);
    expect(lastDealsCall().stageIds).toEqual(["stage-opportunity"]);
  });

  it("Clear resets list dimensions but preserves the board-owned scope URL param (scope is inherited, not a list dimension here)", async () => {
    await renderFB("/deals?scope=all&status=on_hold", { scope: "all" });
    expect(lastDealsCall().scope).toBe("all"); // query scope follows the page prop
    expect(new URLSearchParams(currentSearch).get("status")).toBe("on_hold");
    const clearBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Clear filters"]');
    expect(clearBtn).toBeTruthy();
    await act(async () => {
      clearBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const call = lastDealsCall();
    expect(call.status).toBeUndefined(); // list dimension cleared
    expect(call.scope).toBe("all"); // query scope still follows the prop
    // the board's scope param survives in the URL, so the board's scope toggle keeps its state
    expect(new URLSearchParams(currentSearch).get("scope")).toBe("all");
    expect(new URLSearchParams(currentSearch).get("status")).toBeNull();
  });

  it("Export fetches the SAME #546 filters the list shows (canonical axis), not the legacy export axis", async () => {
    const realCreate = (URL as { createObjectURL?: unknown }).createObjectURL;
    const realRevoke = (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
    (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:x";
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    // useDeals is mocked, so the list never hits the api mock — every api call here IS the export.
    mocks.apiMock.mockResolvedValue({ deals: [makeDeal()], pagination: { totalPages: 1 } });

    await renderFB("/deals?status=on_hold&dateFrom=2026-05-01&dateTo=2026-05-31", { enableExport: true }, FB_PROP_BOARD);
    const exportBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Export");
    expect(exportBtn).toBeTruthy();
    await act(async () => {
      exportBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const exportUrl = mocks.apiMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes("limit=500"));
    expect(exportUrl).toBeTruthy(); // export paginates with the export page size
    expect(exportUrl).toContain("status=on_hold");
    expect(exportUrl).toContain("dateFrom=2026-05-01");
    expect(exportUrl).toContain("page=1");
    expect(exportUrl).not.toContain("isActive="); // status owns lifecycle; no legacy axis
    expect(exportUrl).not.toContain("createdFrom");

    clickSpy.mockRestore();
    (URL as { createObjectURL?: unknown }).createObjectURL = realCreate;
    (URL as { revokeObjectURL?: unknown }).revokeObjectURL = realRevoke;
  });

  // Param namespace (paramPrefix): when the bar mounts on a surface that already owns bare URL params
  // (the director/stage drill-downs), it reads/writes its keys under a prefix (fb_) so the two URL
  // spaces stay disjoint. The mount threads filterBar.paramPrefix into useFilterState(prefix).
  describe("paramPrefix namespace (drill-down mounts share a URL with the host page)", () => {
    it("reads the bar's NAMESPACED (fb_) params when a paramPrefix is set", async () => {
      await renderFB(
        "/deals?fb_dateFrom=2026-05-01&fb_dateTo=2026-05-27&fb_stageIds=stage-opportunity",
        {},
        { ...FB_PROP, paramPrefix: "fb_" }
      );
      const call = lastDealsCall();
      expect(call.dateFrom).toBe("2026-05-01");
      expect(call.dateTo).toBe("2026-05-27");
      expect(call.stageIds).toEqual(["stage-opportunity"]);
    });

    it("does NOT read a BARE host param when a paramPrefix is set (namespace isolation)", async () => {
      // A bare ?dateFrom belongs to the host page's URL space, not the bar's — with the prefix on, the
      // bar must ignore it (it reads only fb_dateFrom), so a host date can't leak into the bar's query.
      await renderFB("/deals?dateFrom=2026-05-01", {}, { ...FB_PROP, paramPrefix: "fb_" });
      expect(lastDealsCall().dateFrom).toBeUndefined();
    });

    it("still reads BARE params when NO paramPrefix is set (the pipeline/base mount is unchanged)", async () => {
      await renderFB("/deals?dateFrom=2026-05-01", {}, FB_PROP);
      expect(lastDealsCall().dateFrom).toBe("2026-05-01");
    });
  });

  // Codex P2s: FilterBar mode must preserve two legacy behaviors the drill-down mounts rely on.
  describe("drill-down defaults (Codex P2)", () => {
    it("applies filterBar.defaultSort when the URL carries no sort (the view's intended order)", async () => {
      await renderFB("/deals", {}, { ...FB_PROP, defaultSort: { key: "contract_signed_date", dir: "desc" } });
      const call = lastDealsCall();
      expect(call.sortBy).toBe("contract_signed_date");
      expect(call.sortDir).toBe("desc");
    });

    it("lets an explicit URL sort override filterBar.defaultSort", async () => {
      await renderFB("/deals?sortBy=created_at&sortDir=asc", {}, { ...FB_PROP, defaultSort: { key: "contract_signed_date", dir: "desc" } });
      const call = lastDealsCall();
      expect(call.sortBy).toBe("created_at");
      expect(call.sortDir).toBe("asc");
    });

    it("keeps the baseFilters date window a FLOOR — a broader bar date can't widen past it", async () => {
      await renderFB(
        "/deals?dateFrom=2026-04-01&dateTo=2026-06-30",
        { baseFilters: { dateFrom: "2026-05-01", dateTo: "2026-05-31" } }
      );
      const call = lastDealsCall();
      expect(call.dateFrom).toBe("2026-05-01"); // floor start held (bar's earlier 04-01 clamped up)
      expect(call.dateTo).toBe("2026-05-31"); // floor end held (bar's later 06-30 clamped down)
    });

    it("lets a narrower bar date intersect within the floor", async () => {
      await renderFB(
        "/deals?dateFrom=2026-05-10&dateTo=2026-05-20",
        { baseFilters: { dateFrom: "2026-05-01", dateTo: "2026-05-31" } }
      );
      const call = lastDealsCall();
      expect(call.dateFrom).toBe("2026-05-10");
      expect(call.dateTo).toBe("2026-05-20");
    });

    it("ignores a URL param for a dimension the mount does not render (hidden-dim leak guard)", async () => {
      // Rep dimension removed -> a stray ?assignedRepId in the URL has no visible control and must not
      // reach the query (else it would silently override a host-owned / pinned filter).
      const noRep = { ...FB_PROP, dimensions: FB_DIMENSIONS.filter((d) => d !== "rep") };
      await renderFB("/deals?assignedRepId=rep-1", {}, noRep);
      expect(lastDealsCall().assignedRepId).toBeUndefined();
    });
  });

  describe("rep drill-down migration: locked rep + running-total card (#3/#4)", () => {
    // The rep drill-down list is the shared FilterBar with Rep OMITTED from dimensions and the rep
    // pinned via baseFilters.assignedRepId. The lock must be unbypassable AND terminal (Won/Lost)
    // deals must still show by default, matching the legacy rep list.
    const REP_SCOPED = {
      ...FB_PROP,
      dimensions: FB_DIMENSIONS.filter((d) => d !== "rep"),
      // canonical terminal id so the adapter requests active+terminal visibility (Q1) like the legacy
      // rep list (no stages selected -> isActive:"pipeline" + terminal inactiveStageIds).
      terminalStageIds: ["stage-won"],
    };

    it("locks the rep via baseFilters and a stray URL rep cannot bypass it", async () => {
      await renderFB(
        "/deals?assignedRepId=rep-other",
        { baseFilters: { assignedRepId: "rep-7" } },
        REP_SCOPED
      );
      // baseFilters wins; the Rep-less mount drops the stray URL rep before mapping.
      expect(lastDealsCall().assignedRepId).toBe("rep-7");
    });

    it("includes terminal (Won/Lost) deals by default via terminalStageIds (matches the legacy rep list)", async () => {
      await renderFB("/deals", { baseFilters: { assignedRepId: "rep-7" } }, REP_SCOPED);
      const call = lastDealsCall();
      expect(call.assignedRepId).toBe("rep-7");
      expect(call.isActive).toBe("pipeline");
      expect(call.inactiveStageIds).toEqual(["stage-won"]);
    });

    it("renders the running-total card with the full-set valueTotal, SAFE-formatted (#4)", async () => {
      mocks.useDealsMock.mockReturnValue({
        deals: [makeDeal()],
        // valueTotal is the SUM over ALL pages, not just total=3 visible — drives the card.
        pagination: { page: 1, limit: 10, total: 3, totalPages: 1, valueTotal: 1234567 },
        loading: false,
        error: null,
        refetch: vi.fn(),
      });
      await renderFB("/deals", { showValueTotal: true, enableExport: true }, REP_SCOPED);
      const total = container.querySelector('[aria-label="Filtered total value"]');
      expect(total?.textContent).toBe("$1,234,567");
    });

    it("shows the SAFE placeholder (never $NaN) when valueTotal is absent", async () => {
      mocks.useDealsMock.mockReturnValue({
        deals: [makeDeal()],
        pagination: { page: 1, limit: 10, total: 1, totalPages: 1 }, // no valueTotal
        loading: false,
        error: null,
        refetch: vi.fn(),
      });
      await renderFB("/deals", { showValueTotal: true }, REP_SCOPED);
      const total = container.querySelector('[aria-label="Filtered total value"]');
      expect(total?.textContent).toBe("--");
      expect(container.textContent ?? "").not.toContain("NaN");
    });

    it("does NOT render the total card unless showValueTotal is set", async () => {
      await renderFB("/deals", { enableExport: true }, REP_SCOPED);
      expect(container.querySelector('[aria-label="Filtered total value"]')).toBeNull();
    });

    it("requests the server-side total (includeValueTotal) ONLY when showValueTotal is set (#4 gating)", async () => {
      await renderFB("/deals", { showValueTotal: true }, REP_SCOPED);
      expect(lastDealsCall().includeValueTotal).toBe(true);
    });

    it("does NOT request the server-side total when showValueTotal is unset", async () => {
      await renderFB("/deals", {}, REP_SCOPED);
      expect(lastDealsCall().includeValueTotal).toBeFalsy();
    });
  });
});

describe("shouldResetNamespacedPage (fb_ page reset on host change — Codex P2)", () => {
  it("does NOT reset on first observation (a bookmarked fb_page>1 loads intact)", () => {
    expect(shouldResetNamespacedPage(null, "mine|{}", 5)).toBe(false);
  });
  it("does NOT reset when the host key is unchanged", () => {
    expect(shouldResetNamespacedPage("mine|{}", "mine|{}", 5)).toBe(false);
  });
  it("resets when the host key changes and the page is past 1", () => {
    expect(shouldResetNamespacedPage("mine|{a:1}", "all|{a:1}", 5)).toBe(true);
  });
  it("does NOT reset when already on page 1", () => {
    expect(shouldResetNamespacedPage("mine|{}", "all|{}", 1)).toBe(false);
  });
});
