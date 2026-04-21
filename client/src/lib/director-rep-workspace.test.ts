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

  it("normalizes invalid page sizes to a single row per page", () => {
    const state = buildDirectorRepWorkspaceState(rows, {
      query: "",
      sortKey: "pipeline",
      page: 1,
      pageSize: 0,
    });

    expect(state.pageSize).toBe(1);
    expect(state.totalPages).toBe(3);
    expect(state.rows.map((row) => row.repId)).toEqual(["rep-2"]);
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

  it("keeps tied pipeline rows in a deterministic order", () => {
    const tiedRows: DirectorRepWorkspaceRow[] = [
      {
        repId: "rep-b",
        repName: "Alpha Rep",
        activeDeals: 1,
        pipelineValue: 100000,
        winRate: 40,
        activityScore: 5,
        staleDeals: 0,
        staleLeads: 0,
      },
      {
        repId: "rep-a",
        repName: "Alpha Rep",
        activeDeals: 1,
        pipelineValue: 100000,
        winRate: 40,
        activityScore: 5,
        staleDeals: 0,
        staleLeads: 0,
      },
      {
        repId: "rep-c",
        repName: "Bravo Rep",
        activeDeals: 1,
        pipelineValue: 100000,
        winRate: 40,
        activityScore: 5,
        staleDeals: 0,
        staleLeads: 0,
      },
    ];

    const firstPage = buildDirectorRepWorkspaceState(tiedRows, {
      query: "",
      sortKey: "pipeline",
      page: 1,
      pageSize: 2,
    });
    const secondPage = buildDirectorRepWorkspaceState(tiedRows, {
      query: "",
      sortKey: "pipeline",
      page: 2,
      pageSize: 2,
    });

    expect(firstPage.rows.map((row) => row.repId)).toEqual(["rep-a", "rep-b"]);
    expect(secondPage.rows.map((row) => row.repId)).toEqual(["rep-c"]);
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
  it("clamps the current page into the available range", () => {
    expect(clampDirectorRepWorkspacePage({ page: 4, totalRows: 3, pageSize: 2 })).toBe(2);
    expect(clampDirectorRepWorkspacePage({ page: 2, totalRows: 0, pageSize: 25 })).toBe(1);
  });
});
