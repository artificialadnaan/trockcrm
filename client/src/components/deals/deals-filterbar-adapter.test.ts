import { describe, expect, it } from "vitest";
import {
  applyBoardVisibilityDefaults,
  filterBarValueToDealFilters,
  getBoardVisibleStageScope,
  getDealDisplayDate,
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

  it("forwards numeric value + stalled-age ranges", () => {
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
