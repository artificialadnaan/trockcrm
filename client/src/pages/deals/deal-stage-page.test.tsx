import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const mocks = vi.hoisted(() => ({
  useDealStagePageMock: vi.fn(),
  useNormalizedStageRouteMock: vi.fn(),
  useRegionsMock: vi.fn(),
  useProjectTypesMock: vi.fn(),
  usePipelineStagesMock: vi.fn(),
  useTaskAssigneesMock: vi.fn(),
  useAuthMock: vi.fn(),
  dealsListSectionMock: vi.fn(),
}));

vi.mock("@/hooks/use-deals", () => ({ useDealStagePage: mocks.useDealStagePageMock }));
vi.mock("@/lib/pipeline-scope", () => ({ useNormalizedStageRoute: mocks.useNormalizedStageRouteMock }));
vi.mock("@/hooks/use-pipeline-config", () => ({
  useRegions: mocks.useRegionsMock,
  useProjectTypes: mocks.useProjectTypesMock,
  usePipelineStages: mocks.usePipelineStagesMock,
}));
vi.mock("@/hooks/use-task-assignees", () => ({ useTaskAssignees: mocks.useTaskAssigneesMock }));
vi.mock("@/lib/auth", () => ({ useAuth: mocks.useAuthMock }));
vi.mock("@/components/pipeline/pipeline-stage-page-header", () => ({
  PipelineStagePageHeader: ({
    children,
    backTo,
    title,
    subtitle,
    summary,
  }: {
    children: ReactNode;
    backTo: string;
    title: string;
    subtitle?: string;
    summary?: ReactNode;
  }) => (
    <div>
      <a href={backTo}>Back to board</a>
      <h1>{title}</h1>
      {subtitle ? <p>{subtitle}</p> : null}
      {summary}
      {children}
    </div>
  ),
}));
vi.mock("@/components/deals/deals-list-section", () => ({
  DealsListSection: (props: Record<string, unknown>) => {
    mocks.dealsListSectionMock(props);
    return <section data-testid="deals-list-section" />;
  },
}));

import { DealStagePage, buildStageSummaryFilters, appendInheritedTerminalDateToBarSearch } from "./deal-stage-page";

const lastListProps = () =>
  mocks.dealsListSectionMock.mock.calls[mocks.dealsListSectionMock.mock.calls.length - 1]?.[0] as Record<
    string,
    any
  >;

function renderStage(path = "/deals/stages/stage-estimating?scope=team") {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/deals/stages/:stageId" element={<DealStagePage />} />
      </Routes>
    </MemoryRouter>
  );
}

function setStage(stage: { id: string; name: string; slug: string }) {
  mocks.useDealStagePageMock.mockReturnValue({
    loading: false,
    error: null,
    data: {
      stage,
      summary: { count: 1, totalValue: 15000, averageDaysInStage: 4 },
      pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
      rows: [],
    },
  });
}

describe("DealStagePage", () => {
  beforeEach(() => {
    mocks.dealsListSectionMock.mockReset();
    mocks.useRegionsMock.mockReturnValue({ regions: [{ id: "region-1", name: "Dallas" }] });
    mocks.useProjectTypesMock.mockReturnValue({ projectTypes: [{ id: "type-1", name: "Multifamily" }] });
    mocks.useTaskAssigneesMock.mockReturnValue({ assignees: [{ id: "rep-1", displayName: "Alex Rep" }] });
    mocks.useAuthMock.mockReturnValue({ user: { role: "admin" } });
    mocks.usePipelineStagesMock.mockReturnValue({
      loading: false,
      stages: [
        { id: "stage-estimating", slug: "estimating", name: "Estimating" },
        { id: "s-won", slug: "won", name: "Won" },
        { id: "s-closed-won", slug: "closed_won", name: "Closed Won" },
        { id: "s-lost", slug: "lost", name: "Lost" },
      ],
    });
    mocks.useNormalizedStageRouteMock.mockReturnValue({
      needsRedirect: false,
      redirectTo: "/deals/stages/stage-estimating?scope=team",
      backTo: "/deals?scope=team",
      query: { scope: "team", page: 1, pageSize: 25, sort: "", search: "", filters: { staleOnly: false } },
      onPageChange: vi.fn(),
    });
    setStage({ id: "stage-estimating", name: "Estimating", slug: "estimating" });
  });

  it("keeps the stage summary header + back link (whole-stage totals)", () => {
    const html = renderStage();
    expect(html).toContain("Back to board");
    expect(html).toContain("/deals?scope=team");
    expect(html).toContain("Estimating");
    expect(html).toContain("Stage value");
    expect(html).toContain("Avg. visible age");
  });

  it("mounts the shared FilterBar (fb_ namespace, outcome-aware) in place of the legacy grid", () => {
    renderStage();
    const props = lastListProps();
    expect(props.filterBar.paramPrefix).toBe("fb_");
    expect(props.filterBar.stageEntryDateEnabled).toBe(true);
    expect(props.scope).toBe("team");
  });

  it("pins the route's stage: no stage dimension, defaultStageIds + baseFilters scoped to it", () => {
    renderStage();
    const props = lastListProps();
    expect(props.filterBar.dimensions).not.toContain("stage");
    expect(props.filterBar.defaultStageIds).toEqual(["stage-estimating"]);
    expect(props.baseFilters).toEqual({ stageIds: ["stage-estimating"] });
  });

  it("folds the bespoke rep select into the bar for admins, omits it for non-admins", () => {
    renderStage();
    expect(lastListProps().filterBar.dimensions).toContain("rep");

    mocks.dealsListSectionMock.mockReset();
    mocks.useAuthMock.mockReturnValue({ user: { role: "sales" } });
    renderStage();
    expect(lastListProps().filterBar.dimensions).not.toContain("rep");
  });

  it("leaves an active stage's terminalStageIds empty", () => {
    renderStage();
    expect(lastListProps().filterBar.terminalStageIds).toEqual([]);
  });

  // RECONCILIATION (Codex P2): the A′ list must scope to the SAME population the header summary counts,
  // so header count === list count when no bar filter is applied.
  it("reconciles a terminal Won stage to the whole Won alias family the header counts (not just the route id)", () => {
    setStage({ id: "s-won", name: "Won", slug: "won" });
    renderStage("/deals/stages/s-won?scope=team");
    const props = lastListProps();
    // The header (useDealStagePage) broadens Won to its alias family server-side; the list must match.
    expect(props.baseFilters.stageIds).toContain("s-won");
    expect(props.baseFilters.stageIds).toContain("s-closed-won"); // the Won alias the header also counts
    expect(props.filterBar.terminalStageIds).toEqual(props.baseFilters.stageIds); // terminal deals flow through
    expect(props.filterBar.defaultStageIds).toEqual(props.baseFilters.stageIds); // bar scope == list scope
  });

  it("excludes on-hold (migration parking-lot) deals on a Won stage, keeps them on a non-Won stage", () => {
    setStage({ id: "s-won", name: "Won", slug: "won" });
    renderStage("/deals/stages/s-won?scope=team");
    expect(lastListProps().baseFilters.excludeOnHold).toBe(true); // matches the Won summary's exclusion

    mocks.dealsListSectionMock.mockReset();
    setStage({ id: "stage-estimating", name: "Estimating", slug: "estimating" });
    renderStage();
    expect(lastListProps().baseFilters.excludeOnHold).toBeUndefined(); // active stage keeps on-hold deals
  });

  it("redirects inherited bare filters into the fb_ namespace (bar owns them, no invisible floor)", () => {
    // The dashboard nav arrives with a bare ?assignedRepId; the A′ page translates it to fb_ and strips
    // the bare one, so it returns a redirect (the list is not rendered on this pass) — the bar then shows
    // it and Clear can clear it. (getStagePageBarRedirectSearch translation is unit-tested separately.)
    renderStage("/deals/stages/stage-estimating?scope=team&assignedRepId=rep-1");
    expect(mocks.dealsListSectionMock).not.toHaveBeenCalled();
  });

  it("does NOT redirect (renders the list) when the URL carries no bare filter params", () => {
    renderStage("/deals/stages/stage-estimating?scope=team&fb_search=acme");
    expect(mocks.dealsListSectionMock).toHaveBeenCalled();
  });

  it("renders a stage error when the stage query fails", () => {
    mocks.useDealStagePageMock.mockReturnValue({ data: null, loading: false, error: "Failed to load stage" });
    expect(renderStage()).toContain("Failed to load stage");
  });

  // Bug B: the header "Stage value" must reconcile with the board card. The summary query
  // (useDealStagePage) previously ran whole-stage (rep + date stripped at mount). It must now inherit
  // the bar's active rep + date so the total equals the rep/date-scoped board card.
  it("inherits the active fb_ rep + date window into the whole-stage summary query (reconciles with the board card)", () => {
    setStage({ id: "s-won", name: "Won", slug: "won" });
    renderStage("/deals/stages/s-won?scope=team&fb_assignedRepId=rep-1&fb_dateFrom=2026-01-01&fb_dateTo=2026-06-03");
    expect(mocks.useDealStagePageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({
          assignedRepId: "rep-1",
          wonSince: "2026-01-01",
          wonUntil: "2026-06-03",
          lostSince: "2026-01-01",
          lostUntil: "2026-06-03",
        }),
      })
    );
  });

  it("opens an unfiltered drill-down as all-rep + all-time (not the server 30-day default)", () => {
    renderStage("/deals/stages/stage-estimating?scope=team");
    const calls = mocks.useDealStagePageMock.mock.calls;
    const lastCall = calls[calls.length - 1]?.[0];
    expect(lastCall.filters.assignedRepId).toBeUndefined();
    expect(lastCall.filters.wonSince).toBeUndefined();
    expect(lastCall.filters.wonAllTime).toBe(true);
  });

  it("does not rep-scope the summary for a non-admin even if the URL carries fb_assignedRepId", () => {
    mocks.useAuthMock.mockReturnValue({ user: { role: "sales" } });
    setStage({ id: "s-won", name: "Won", slug: "won" });
    renderStage("/deals/stages/s-won?scope=mine&fb_assignedRepId=rep-1");
    const calls = mocks.useDealStagePageMock.mock.calls;
    const lastCall = calls[calls.length - 1]?.[0];
    expect(lastCall.filters.assignedRepId).toBeUndefined();
  });

  it("threads the bar's fb_search into the summary query so the total reflects the searched list", () => {
    setStage({ id: "s-won", name: "Won", slug: "won" });
    renderStage("/deals/stages/s-won?scope=team&fb_search=acme");
    const calls = mocks.useDealStagePageMock.mock.calls;
    const lastCall = calls[calls.length - 1]?.[0];
    expect(lastCall.search).toBe("acme");
  });
});

describe("buildStageSummaryFilters (Bug B: summary inherits the active rep + date)", () => {
  it("reads the fb_ rep + date window into the summary filters (both won + lost windows)", () => {
    const filters = buildStageSummaryFilters(
      new URLSearchParams("fb_assignedRepId=rep-1&fb_dateFrom=2026-01-01&fb_dateTo=2026-06-03"),
      { staleOnly: false },
      { ownRep: true }
    );
    expect(filters.assignedRepId).toBe("rep-1");
    // Outcome-agnostic: set both windows; the server applies only the one matching the stage outcome.
    expect(filters.wonSince).toBe("2026-01-01");
    expect(filters.wonUntil).toBe("2026-06-03");
    expect(filters.lostSince).toBe("2026-01-01");
    expect(filters.lostUntil).toBe("2026-06-03");
  });

  it("falls back to inherited bare params (pre-redirect first paint) so the summary is never momentarily whole-stage", () => {
    const filters = buildStageSummaryFilters(
      new URLSearchParams("assignedRepId=rep-2&won_since=2026-02-01&won_until=2026-05-01"),
      { staleOnly: false },
      { ownRep: true }
    );
    expect(filters.assignedRepId).toBe("rep-2");
    expect(filters.wonSince).toBe("2026-02-01");
    expect(filters.wonUntil).toBe("2026-05-01");
  });

  it("prefers an explicit fb_ value over the inherited bare value", () => {
    const filters = buildStageSummaryFilters(
      new URLSearchParams("fb_assignedRepId=rep-1&assignedRepId=rep-2"),
      { staleOnly: false },
      { ownRep: true }
    );
    expect(filters.assignedRepId).toBe("rep-1");
  });

  // Codex P2: the bar renders Rep only for admins, so a non-admin's list ignores fb_assignedRepId. The
  // summary must ignore it too, or the header is rep-scoped while the visible list (mine/all only) is all-rep.
  it("does NOT apply the rep for non-admins (ownRep:false), but still applies the date window", () => {
    const filters = buildStageSummaryFilters(
      new URLSearchParams("fb_assignedRepId=rep-1&fb_dateFrom=2026-01-01&fb_dateTo=2026-06-03"),
      { staleOnly: false },
      { ownRep: false }
    );
    expect(filters.assignedRepId).toBeUndefined();
    expect(filters.wonSince).toBe("2026-01-01"); // Date dimension is always rendered, so the window still applies
  });

  // Codex P2: an all-time board card (won_all_time, no since/until) must not fall back to the server's
  // 30-day terminal default. No window ⇒ pin all-time so the header matches the all-time card + list.
  it("pins all-time (wonAllTime/lostAllTime) when no window is present, instead of the server 30-day default", () => {
    const filters = buildStageSummaryFilters(new URLSearchParams("scope=team"), { staleOnly: true }, { ownRep: true });
    expect(filters.assignedRepId).toBeUndefined();
    expect(filters.wonSince).toBeUndefined();
    expect(filters.wonAllTime).toBe(true);
    expect(filters.lostAllTime).toBe(true);
    expect(filters.staleOnly).toBe(true); // base filters pass through untouched
  });

  it("does NOT pin all-time when a window is present", () => {
    const filters = buildStageSummaryFilters(
      new URLSearchParams("fb_dateFrom=2026-01-01&fb_dateTo=2026-06-03"),
      { staleOnly: false },
      { ownRep: true }
    );
    expect(filters.wonAllTime).toBeUndefined();
    expect(filters.lostAllTime).toBeUndefined();
  });

  // Codex P2: a bookmarked/shared URL with a relative preset (fb_datePreset=30) + stale bounds must
  // re-resolve to a FRESH window for "now" — matching the list (withResolvedDateWindow) — not the stale
  // saved dates, or the header and list diverge on a later day.
  it("re-resolves a relative fb_ date preset for now instead of using stale bookmarked bounds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T16:00:00Z"));
    const filters = buildStageSummaryFilters(
      new URLSearchParams("fb_datePreset=30&fb_dateFrom=2026-01-01&fb_dateTo=2026-01-31"),
      { staleOnly: false },
      { ownRep: true }
    );
    expect(filters.wonSince).not.toBe("2026-01-01"); // not the stale saved lower bound
    expect(filters.wonSince).toBe("2026-04-01"); // 30 days before 2026-05-01
    expect(filters.wonUntil).toBe("2026-05-01"); // today
    vi.useRealTimers();
  });

  // GREEN (#616 follow-up): the top "Stage Value" must follow ALL the list filters, not just rep+date —
  // status, workflow, type, value, and stalled (days-in-stage) all narrow the deal set, so all flow in.
  it("inherits the remaining list filters (status, workflow, region, type, value, stalled) from the fb_ namespace", () => {
    const filters = buildStageSummaryFilters(
      new URLSearchParams(
        "fb_status=on_hold&fb_workflowRoute=service&fb_regionId=region-1&fb_projectTypeId=type-1&fb_valueMin=1000&fb_valueMax=50000&fb_minAgeDays=7&fb_maxAgeDays=30"
      ),
      { staleOnly: false },
      { ownRep: true }
    );
    expect(filters.status).toBe("on_hold");
    expect(filters.workflowRoute).toBe("service");
    expect(filters.regionId).toBe("region-1");
    expect(filters.projectTypeId).toBe("type-1");
    expect(filters.valueMin).toBe("1000");
    expect(filters.valueMax).toBe("50000");
    expect(filters.minAgeDays).toBe("7");
    expect(filters.maxAgeDays).toBe("30");
  });

  it("drops a non-deal fb_status (e.g. a lead status) so the summary doesn't no-match while the list is unfiltered", () => {
    const filters = buildStageSummaryFilters(
      new URLSearchParams("fb_status=open"),
      { staleOnly: false },
      { ownRep: true }
    );
    expect(filters.status).toBeUndefined();
  });

  it("drops malformed or blank fb_ numeric filters (value/age) so the summary stays unfiltered like the bar", () => {
    const filters = buildStageSummaryFilters(
      new URLSearchParams("fb_valueMin=abc&fb_valueMax=xyz&fb_minAgeDays=nope&fb_maxAgeDays=bad"),
      { staleOnly: false },
      { ownRep: true }
    );
    expect(filters.valueMin).toBeUndefined();
    expect(filters.valueMax).toBeUndefined();
    expect(filters.minAgeDays).toBeUndefined();
    expect(filters.maxAgeDays).toBeUndefined();

    // Blank/whitespace must be unset too (Number(" ") === 0 would otherwise read as a 0 bound) — mirrors
    // the bar's parseNumberParam trim guard (Codex P3).
    const blank = buildStageSummaryFilters(
      new URLSearchParams("fb_valueMin=%20&fb_minAgeDays=%20"),
      { staleOnly: false },
      { ownRep: true }
    );
    expect(blank.valueMin).toBeUndefined();
    expect(blank.minAgeDays).toBeUndefined();
  });
});

describe("appendInheritedTerminalDateToBarSearch (Bug B: carry inherited window into fb_ so list + header agree)", () => {
  it("translates an inherited Won window into the bar's fb_ date namespace", () => {
    const out = appendInheritedTerminalDateToBarSearch(
      "scope=team&fb_assignedRepId=rep-1",
      new URLSearchParams("scope=team&assignedRepId=rep-1&won_since=2026-01-01&won_until=2026-06-03")
    );
    const params = new URLSearchParams(out);
    expect(params.get("fb_dateFrom")).toBe("2026-01-01");
    expect(params.get("fb_dateTo")).toBe("2026-06-03");
  });

  it("translates an inherited Lost window into the bar's fb_ date namespace", () => {
    const out = appendInheritedTerminalDateToBarSearch(
      "scope=team",
      new URLSearchParams("lost_since=2026-02-01&lost_until=2026-05-01")
    );
    const params = new URLSearchParams(out);
    expect(params.get("fb_dateFrom")).toBe("2026-02-01");
    expect(params.get("fb_dateTo")).toBe("2026-05-01");
  });

  it("does not clobber an fb_ date the user already set on the bar", () => {
    const out = appendInheritedTerminalDateToBarSearch(
      "fb_dateFrom=2026-03-01",
      new URLSearchParams("won_since=2026-01-01&won_until=2026-06-03")
    );
    const params = new URLSearchParams(out);
    expect(params.get("fb_dateFrom")).toBe("2026-03-01");
  });

  it("returns the search unchanged when there is no inherited terminal window", () => {
    const out = appendInheritedTerminalDateToBarSearch(
      "scope=team&fb_assignedRepId=rep-1",
      new URLSearchParams("scope=team&assignedRepId=rep-1")
    );
    expect(new URLSearchParams(out).has("fb_dateFrom")).toBe(false);
  });
});
