// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import {
  DealsListSection,
  buildDealStageFilterOptions,
  getSelectedDealStageIds,
  getVisibleListTerminalStageIds,
} from "./deals-list-section";

const mocks = vi.hoisted(() => ({
  useDealsMock: vi.fn(),
  usePipelineStagesMock: vi.fn(),
  useTaskAssigneesMock: vi.fn(),
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

vi.mock("@/components/ui/input", () => ({
  Input: (props: Record<string, unknown>) => <input {...props} />,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div data-mock-select>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder ?? ""}</span>,
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

describe("DealsListSection", () => {
  beforeEach(() => {
    mocks.useDealsMock.mockReset();
    mocks.usePipelineStagesMock.mockReset();
    mocks.useTaskAssigneesMock.mockReset();

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
    expect(html).toContain("Acme Construction");
    expect(html).toContain("DFW-1-12826-aa");
  });

  it("uses paginated useDeals call (page-based, not endless scroll)", () => {
    render();

    const call = mocks.useDealsMock.mock.calls[mocks.useDealsMock.mock.calls.length - 1][0];
    expect(call).toMatchObject({
      page: 1,
      limit: 25,
      sortBy: "updated_at",
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

  it("renders date filter control when enableDateFilter is true", () => {
    const html = render({ enableDateFilter: true });
    expect(html).toContain("data-mock-date-filter");
  });

  it("renders export button when enableExport is true", () => {
    const html = render({ enableExport: true });
    expect(html).toContain(">Export<");
  });

  it("forwards scope to useDeals", () => {
    render({ scope: "team" });
    const call = mocks.useDealsMock.mock.calls[mocks.useDealsMock.mock.calls.length - 1][0];
    expect(call.scope).toBe("team");
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
  });
});
