import { describe, expect, it } from "vitest";
import {
  applyBoardVisibilityDefaults,
  buildDrilldownListFilterBar,
  DRILLDOWN_FILTERBAR_PARAM_PREFIX,
  filterBarValueToDealFilters,
  getBoardVisibleStageScope,
  getDealDisplayDate,
  getDrilldownFilterBarDimensions,
  pickFilterBarValueForDimensions,
} from "./deals-filterbar-adapter";
import type { FilterBarValue } from "@/components/filters/filterbar-params";

describe("filterBarValueToDealFilters (FilterBar URL value -> useDeals DealFilters)", () => {
  it("maps an empty value to an empty filter object (no stray keys)", () => {
    expect(filterBarValueToDealFilters({})).toEqual({});
  });

  it("passes the simple dimensions through under the contract field names", () => {
    const value: FilterBarValue = {
      search: "acme",
      stageIds: ["stage-a", "stage-b"],
      assignedRepId: "rep-1",
      regionId: "region-1",
      projectTypeId: "type-1",
      workflowRoute: "service",
      sortBy: "awarded_amount",
      sortDir: "desc",
      scope: "team",
    };
    expect(filterBarValueToDealFilters(value)).toEqual({
      search: "acme",
      stageIds: ["stage-a", "stage-b"],
      assignedRepId: "rep-1",
      regionId: "region-1",
      projectTypeId: "type-1",
      workflowRoute: "service",
      sortBy: "awarded_amount",
      sortDir: "desc",
      scope: "team",
    });
  });

  it("emits the outcome-aware date window (dateFrom/dateTo) and DROPS the client-only datePreset", () => {
    const result = filterBarValueToDealFilters({ datePreset: "mtd", dateFrom: "2026-05-01", dateTo: "2026-05-27" });
    expect(result).toEqual({ dateFrom: "2026-05-01", dateTo: "2026-05-27" });
    expect("datePreset" in result).toBe(false);
  });

  it("forwards the Unassigned sentinel verbatim (backend maps __unassigned__ -> IS NULL)", () => {
    expect(filterBarValueToDealFilters({ assignedRepId: "__unassigned__", regionId: "__unassigned__" })).toEqual({
      assignedRepId: "__unassigned__",
      regionId: "__unassigned__",
    });
  });

  it("forwards a real status but OMITS 'any' (the no-filter state)", () => {
    expect(filterBarValueToDealFilters({ status: "on_hold" })).toEqual({ status: "on_hold" });
    const any = filterBarValueToDealFilters({ status: "any" });
    expect("status" in any).toBe(false);
  });

  it("forwards numeric value + stalled-age ranges (the mount, not this pure mapper, forces stageEntryDateWindow)", () => {
    // The stage_entry_window override that makes age/date filters bound open rows regardless of the
    // env flag is applied at the outcome-aware mount (deals-list-section, gated on stageEntryDateEnabled),
    // NOT here — this mapper stays a pure URL->DealFilters translation. See the FilterBar section tests.
    expect(
      filterBarValueToDealFilters({ valueMin: 1000, valueMax: 50000, minAgeDays: 30, maxAgeDays: 90 })
    ).toEqual({ valueMin: 1000, valueMax: 50000, minAgeDays: 30, maxAgeDays: 90 });
  });

  it("does NOT carry pagination (page) — the list section owns page/limit, not the filter map", () => {
    const result = filterBarValueToDealFilters({ page: 3, search: "x" });
    expect("page" in result).toBe(false);
    expect(result).toEqual({ search: "x" });
  });

  it("omits empty stageIds rather than sending an empty array", () => {
    const result = filterBarValueToDealFilters({ stageIds: [] });
    expect("stageIds" in result).toBe(false);
  });

  it("preserves zero-valued numeric ranges (0 is a real bound, distinct from 'unset')", () => {
    expect(filterBarValueToDealFilters({ valueMin: 0, valueMax: 0, minAgeDays: 0, maxAgeDays: 0 })).toEqual({
      valueMin: 0,
      valueMax: 0,
      minAgeDays: 0,
      maxAgeDays: 0,
    });
  });

  it("never emits the legacy isActive — Status owns is_active/on_hold (contract §5)", () => {
    const result = filterBarValueToDealFilters({ status: "inactive" });
    expect("isActive" in result).toBe(false);
    expect(result).toEqual({ status: "inactive" });
  });
});

describe("applyBoardVisibilityDefaults (the under-kanban list mirrors the board it sits under)", () => {
  const board = { defaultStageIds: ["s-opp", "s-est", "s-won", "s-lost"], terminalStageIds: ["s-won", "s-lost"] };

  it("Q1: with no Status chosen, sends mixed visibility (active + named terminal) so the list shows terminal deals like the board", () => {
    const result = applyBoardVisibilityDefaults(filterBarValueToDealFilters({}), board);
    // active-only is the contract §5 default; this mount OVERRIDES it to active+terminal to match the board.
    expect(result.isActive).toBe("pipeline");
    expect(result.inactiveStageIds).toEqual(["s-won", "s-lost"]);
  });

  it("Q2: with no stages chosen, defaults stageIds to the board's visible columns (so DD hides when the board hides it)", () => {
    const result = applyBoardVisibilityDefaults(filterBarValueToDealFilters({}), board);
    expect(result.stageIds).toEqual(["s-opp", "s-est", "s-won", "s-lost"]);
  });

  it("respects an explicit stage selection (the user's pick overrides the board default)", () => {
    const result = applyBoardVisibilityDefaults(filterBarValueToDealFilters({ stageIds: ["s-est"] }), board);
    expect(result.stageIds).toEqual(["s-est"]);
    // visibility still mirrors the board (no Status chosen)
    expect(result.isActive).toBe("pipeline");
    expect(result.inactiveStageIds).toEqual(["s-won", "s-lost"]);
  });

  it("intersects an explicit selection with the board's visible stages — a hidden stage (DD after Show-DD off) cannot linger in the list query (Q2 / Codex)", () => {
    // board.defaultStageIds omits the DD id (Show-DD is OFF); the URL still carries a stale DD selection
    const result = applyBoardVisibilityDefaults(filterBarValueToDealFilters({ stageIds: ["s-dd", "s-est"] }), board);
    expect(result.stageIds).toEqual(["s-est"]); // s-dd dropped — it is no longer a visible board column
  });

  it("falls back to the board's full visible set when every explicit pick is now hidden", () => {
    const result = applyBoardVisibilityDefaults(filterBarValueToDealFilters({ stageIds: ["s-dd"] }), board);
    expect(result.stageIds).toEqual(["s-opp", "s-est", "s-won", "s-lost"]); // never query a hidden stage
  });

  it("does NOT intersect when no board context is given (generic mounts keep the explicit selection as-is)", () => {
    const result = applyBoardVisibilityDefaults(filterBarValueToDealFilters({ stageIds: ["s-dd", "s-est"] }), {});
    expect(result.stageIds).toEqual(["s-dd", "s-est"]);
  });

  it("yields to an explicit Status — it owns is_active/on_hold server-side, so isActive is NOT forced", () => {
    const active = applyBoardVisibilityDefaults(filterBarValueToDealFilters({ status: "active" }), board);
    expect(active.status).toBe("active");
    expect(active.isActive).toBeUndefined();
    expect(active.inactiveStageIds).toBeUndefined();
    // the board-visible stage default still applies (Status narrows lifecycle, not which stages are on the page)
    expect(active.stageIds).toEqual(["s-opp", "s-est", "s-won", "s-lost"]);

    const inactive = applyBoardVisibilityDefaults(filterBarValueToDealFilters({ status: "inactive" }), board);
    expect(inactive.status).toBe("inactive");
    expect(inactive.isActive).toBeUndefined();
  });

  it("falls back to the contract active-only default when a mount provides no terminal stage ids", () => {
    const result = applyBoardVisibilityDefaults(filterBarValueToDealFilters({}), { defaultStageIds: ["s-opp"] });
    expect(result.stageIds).toEqual(["s-opp"]);
    expect(result.isActive).toBeUndefined();
    expect(result.inactiveStageIds).toBeUndefined();
  });

  it("is a pass-through when no board context is given (generic FilterBar mounts are unaffected)", () => {
    const mapped = filterBarValueToDealFilters({ search: "acme", dateFrom: "2026-05-01" });
    expect(applyBoardVisibilityDefaults(mapped, {})).toEqual(mapped);
  });

  it("preserves the other mapped dimensions while layering visibility", () => {
    const result = applyBoardVisibilityDefaults(
      filterBarValueToDealFilters({ assignedRepId: "rep-1", valueMin: 1000, dateFrom: "2026-05-01" }),
      board
    );
    expect(result).toMatchObject({ assignedRepId: "rep-1", valueMin: 1000, dateFrom: "2026-05-01" });
  });
});

describe("getBoardVisibleStageScope (board columns -> the list's default stage scope)", () => {
  const isTerminal = (slug: string) => slug === "won" || slug === "lost";
  const columns = [
    { id: "s-opp", slug: "opportunity" },
    { id: "s-dd", slug: "due_diligence" },
    { id: "s-est", slug: "estimate_in_progress" },
    { id: "s-won", slug: "won" },
    { id: "s-lost", slug: "lost" },
  ];

  it("excludes Due Diligence columns when the board's Show-DD toggle is OFF", () => {
    const scope = getBoardVisibleStageScope(columns, false, isTerminal);
    expect(scope.defaultStageIds).toEqual(["s-opp", "s-est", "s-won", "s-lost"]);
    expect(scope.defaultStageIds).not.toContain("s-dd");
  });

  it("includes Due Diligence columns when Show-DD is ON", () => {
    const scope = getBoardVisibleStageScope(columns, true, isTerminal);
    expect(scope.defaultStageIds).toEqual(["s-opp", "s-dd", "s-est", "s-won", "s-lost"]);
  });

  it("surfaces the visible TERMINAL columns as the inactive-stage set (so terminal deals flow through)", () => {
    const scope = getBoardVisibleStageScope(columns, true, isTerminal);
    expect(scope.terminalStageIds).toEqual(["s-won", "s-lost"]);
  });
});

describe("getDealDisplayDate (filter-axis == display-axis: prefer the server's outcome-aware displayDate)", () => {
  it("returns the backend-provided displayDate when present, even if close dates also exist", () => {
    expect(
      getDealDisplayDate({ displayDate: "2026-05-20", actualCloseDate: "2026-01-01", expectedCloseDate: "2026-02-02" })
    ).toBe("2026-05-20");
  });

  it("falls back to actualCloseDate when displayDate is absent (pre-P0 behavior preserved)", () => {
    expect(getDealDisplayDate({ actualCloseDate: "2026-03-03", expectedCloseDate: "2026-04-04" })).toBe("2026-03-03");
  });

  it("falls back to expectedCloseDate when neither displayDate nor actualCloseDate is set", () => {
    expect(getDealDisplayDate({ displayDate: null, actualCloseDate: null, expectedCloseDate: "2026-04-04" })).toBe(
      "2026-04-04"
    );
  });

  it("returns null when no date axis is available", () => {
    expect(getDealDisplayDate({ displayDate: null, actualCloseDate: null, expectedCloseDate: null })).toBeNull();
    expect(getDealDisplayDate({})).toBeNull();
  });
});

// Director/stage drill-down FilterBar mounts (e.g. /deals/stages/<id>, the /deals Won/Active/At-risk
// drill-downs). These surfaces already carry their own URL state (scope, period, filter, page, the
// page-owned rep select), so the bar mounts under a param NAMESPACE so its keys never collide.
describe("DRILLDOWN_FILTERBAR_PARAM_PREFIX (namespace for drill-down/stage bar mounts)", () => {
  it("is a non-empty prefix ending in a separator so bar keys never alias a bare drill-down param", () => {
    // The bare drill-down params (scope, period, filter, page, assignedRepId) are un-prefixed; the bar
    // serializes its keys as `${prefix}${key}` (e.g. fb_stageIds, fb_page) so the two URL spaces are disjoint.
    expect(DRILLDOWN_FILTERBAR_PARAM_PREFIX.length).toBeGreaterThan(0);
    expect(DRILLDOWN_FILTERBAR_PARAM_PREFIX.endsWith("_")).toBe(true);
  });

  it("namespaces the bar's `page` away from the stage drill-down's own `page` param", () => {
    // deal-stage-page.tsx drives pagination via a bare ?page; the bar also has a `page` key. With the
    // prefix the bar's page becomes fb_page, so paging the bar can't clobber the stage page's paging.
    expect(`${DRILLDOWN_FILTERBAR_PARAM_PREFIX}page`).not.toBe("page");
  });
});

describe("getDrilldownFilterBarDimensions (per-surface dimension set)", () => {
  it("defaults (dashboard drill-down) to the full set MINUS scope (page toggle) and rep (page/board select)", () => {
    expect(getDrilldownFilterBarDimensions()).toEqual([
      "search",
      "date",
      "stage",
      "sort",
      "status",
      "workflow",
      "region",
      "projectType",
      "value",
      "stalled",
    ]);
  });

  it("never includes scope on any surface (scope stays the page's own toggle, not a bar dimension)", () => {
    for (const opts of [{}, { ownRep: true }, { pinnedStage: true }, { pinnedStage: true, ownRep: true }]) {
      expect(getDrilldownFilterBarDimensions(opts)).not.toContain("scope");
    }
  });

  it("adds rep right after sort when the bar OWNS rep (stage page folds in its bespoke rep select)", () => {
    const dims = getDrilldownFilterBarDimensions({ ownRep: true });
    expect(dims).toContain("rep");
    expect(dims.indexOf("rep")).toBe(dims.indexOf("sort") + 1);
  });

  it("drops the stage multi-select when the surface PINS a stage (the /deals/stages/<id> route fixes it)", () => {
    expect(getDrilldownFilterBarDimensions({ pinnedStage: true })).not.toContain("stage");
  });

  it("the stage-page set (pinned stage + bar-owned rep) is the full dim row minus the stage picker", () => {
    expect(getDrilldownFilterBarDimensions({ pinnedStage: true, ownRep: true })).toEqual([
      "search",
      "date",
      "sort",
      "rep",
      "status",
      "workflow",
      "region",
      "projectType",
      "value",
      "stalled",
    ]);
  });
});

describe("buildDrilldownListFilterBar (the /deals dashboard drill-down list mount config)", () => {
  const visibleStages = [
    { id: "stage-opp", slug: "opportunity", name: "Opportunity" },
    { id: "stage-won", slug: "won", name: "Won" },
  ];
  const build = () =>
    buildDrilldownListFilterBar({
      visibleStages,
      isTerminalSlug: (slug) => slug === "won",
      regions: [{ id: "region-1", name: "DFW" }],
      projectTypes: [{ id: "type-1", name: "Multifamily" }],
    });

  it("namespaces the bar (fb_) and marks it outcome-aware (flag is on in prod)", () => {
    const cfg = build();
    expect(cfg.paramPrefix).toBe(DRILLDOWN_FILTERBAR_PARAM_PREFIX);
    expect(cfg.stageEntryDateEnabled).toBe(true);
  });

  it("uses the dashboard dimension set — no rep (the page's rep select drives board + list)", () => {
    expect(build().dimensions).not.toContain("rep");
    expect(build().dimensions).toContain("stage");
  });

  it("mirrors the drill-down's visible stages as the stage scope + multi-select options", () => {
    const cfg = build();
    expect(cfg.defaultStageIds).toEqual(["stage-opp", "stage-won"]);
    expect(cfg.terminalStageIds).toEqual(["stage-won"]); // terminal subset flows through as inactiveStageIds
    expect(cfg.options.stages).toEqual([
      { value: "stage-opp", label: "Opportunity" },
      { value: "stage-won", label: "Won" },
    ]);
  });

  it("maps region + project-type option sources for their dimensions", () => {
    const cfg = build();
    expect(cfg.options.regions).toEqual([{ value: "region-1", label: "DFW" }]);
    expect(cfg.options.projectTypes).toEqual([{ value: "type-1", label: "Multifamily" }]);
    expect(cfg.options.sortOptions).toBeDefined();
  });
});

describe("pickFilterBarValueForDimensions (drop URL params for dimensions a mount doesn't render)", () => {
  const full: FilterBarValue = {
    search: "acme",
    stageIds: ["stage-a"],
    assignedRepId: "rep-1",
    regionId: "region-1",
    valueMin: 1000,
    dateFrom: "2026-05-01",
    status: "active",
  };

  it("keeps only the value keys mapped to the rendered dimensions", () => {
    // A stage-page-style mount: stage pinned (no stage dim), rep hidden (non-admin) -> a stray
    // fb_stageIds / fb_assignedRepId in the URL must NOT reach the query.
    const picked = pickFilterBarValueForDimensions(full, ["search", "date", "value", "status"]);
    expect(picked).toEqual({ search: "acme", valueMin: 1000, dateFrom: "2026-05-01", status: "active" });
    expect(picked.stageIds).toBeUndefined();
    expect(picked.assignedRepId).toBeUndefined();
    expect(picked.regionId).toBeUndefined();
  });

  it("keeps rep + stage when those dimensions ARE rendered", () => {
    const picked = pickFilterBarValueForDimensions(full, ["stage", "rep"]);
    expect(picked.stageIds).toEqual(["stage-a"]);
    expect(picked.assignedRepId).toBe("rep-1");
    expect(picked.search).toBeUndefined();
  });

  it("returns an empty value when no dimensions are rendered", () => {
    expect(pickFilterBarValueForDimensions(full, [])).toEqual({});
  });
});
