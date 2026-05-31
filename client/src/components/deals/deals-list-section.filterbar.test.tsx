// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { DealsListSection } from "./deals-list-section";
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

const lastDealsCall = () => mocks.useDealsMock.mock.calls[mocks.useDealsMock.mock.calls.length - 1][0];

let container: HTMLDivElement;
let root: Root | null;

async function renderFB(
  url: string,
  extraProps: Parameters<typeof DealsListSection>[0] = {},
  filterBar: NonNullable<Parameters<typeof DealsListSection>[0]["filterBar"]> = FB_PROP
) {
  await act(async () => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={[url]}>
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
    await renderFB("/deals", { scope: "team" });
    expect(lastDealsCall().scope).toBe("team");
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

  it("preserves the page-owned scope param on Clear (scope is inherited, not a list dimension here)", async () => {
    await renderFB("/deals?scope=all&status=on_hold");
    expect(lastDealsCall().scope).toBe("all");
    const clearBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Clear filters"]');
    expect(clearBtn).toBeTruthy();
    await act(async () => {
      clearBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const call = lastDealsCall();
    expect(call.scope).toBe("all"); // board scope survives the list reset
    expect(call.status).toBeUndefined(); // list dimension cleared
  });
});
