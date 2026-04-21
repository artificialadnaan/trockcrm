import { describe, expect, it } from "vitest";
import {
  buildDirectorRepWorkspaceState,
  clampDirectorRepWorkspacePage,
  type DirectorRepWorkspaceRow,
} from "./director-rep-workspace";

const rows: DirectorRepWorkspaceRow[] = [
  {
    repId: "rep-1",
    repName: "Alpha Rep",
    activeDeals: 4,
    pipelineValue: 150000,
    winRate: 40,
    activityScore: 12,
    staleDeals: 1,
    staleLeads: 0,
  },
  {
    repId: "rep-2",
    repName: "Bravo Rep",
    activeDeals: 7,
    pipelineValue: 450000,
    winRate: 55,
    activityScore: 3,
    staleDeals: 2,
    staleLeads: 2,
  },
  {
    repId: "rep-3",
    repName: "Charlie Rep",
    activeDeals: 2,
    pipelineValue: 90000,
    winRate: 80,
    activityScore: 30,
    staleDeals: 0,
    staleLeads: 0,
  },
];

describe("buildDirectorRepWorkspaceState", () => {
  it("sorts by pipeline descending by default", () => {
    const state = buildDirectorRepWorkspaceState(rows, {
      query: "",
      sortKey: "pipeline",
      page: 1,
      pageSize: 25,
    });

    expect(state.rows.map((row) => row.repId)).toEqual(["rep-2", "rep-1", "rep-3"]);
  });

  it("filters by rep name and recalculates totals", () => {
    const state = buildDirectorRepWorkspaceState(rows, {
      query: "char",
      sortKey: "pipeline",
      page: 1,
      pageSize: 25,
    });

    expect(state.totalRows).toBe(1);
    expect(state.rows.map((row) => row.repId)).toEqual(["rep-3"]);
  });

  it("ranks stale risk before raw pipeline when requested", () => {
    const state = buildDirectorRepWorkspaceState(rows, {
      query: "",
      sortKey: "staleRisk",
      page: 1,
      pageSize: 25,
    });

    expect(state.rows[0]?.repId).toBe("rep-2");
  });

  it("returns one page slice at a time", () => {
    const state = buildDirectorRepWorkspaceState(rows, {
      query: "",
      sortKey: "repName",
      page: 2,
      pageSize: 2,
    });

    expect(state.totalPages).toBe(2);
    expect(state.rows.map((row) => row.repId)).toEqual(["rep-3"]);
  });
});

describe("clampDirectorRepWorkspacePage", () => {
  it("resets to page 1 when the current page is out of range", () => {
    expect(clampDirectorRepWorkspacePage({ page: 4, totalRows: 3, pageSize: 2 })).toBe(2);
    expect(clampDirectorRepWorkspacePage({ page: 2, totalRows: 0, pageSize: 25 })).toBe(1);
  });
});
