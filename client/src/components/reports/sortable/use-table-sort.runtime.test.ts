// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { DirectorScorecardReport } from "@/hooks/use-reports";
import { useTableSort, type SortColumn, type UseTableSortOptions, type UseTableSortResult } from "./use-table-sort";

type RepRow = DirectorScorecardReport["repPerformance"][number];

const ROWS: RepRow[] = [
  { repName: "Colby", openDeals: 9, pipelineValue: 100, wonThisPeriod: 1, winRate: 0.5, activityScore: 2 },
  { repName: "ana", openDeals: 100, pipelineValue: 10, wonThisPeriod: 3, winRate: 0.1, activityScore: 9 },
  { repName: "Beth", openDeals: 10, pipelineValue: 50, wonThisPeriod: 2, winRate: 0.9, activityScore: 5 },
];

const COLUMNS: ReadonlyArray<SortColumn<RepRow>> = [
  { key: "repName", type: "text", accessor: (r) => r.repName },
  { key: "openDeals", type: "number", accessor: (r) => r.openDeals },
];

async function renderHook(
  options?: UseTableSortOptions,
  rows: RepRow[] = ROWS,
  columns: ReadonlyArray<SortColumn<RepRow>> = COLUMNS,
) {
  const container = document.createElement("div");
  const root = createRoot(container);
  let api: UseTableSortResult<RepRow>;
  function Probe() {
    api = useTableSort(rows, columns, options);
    return null;
  }
  await act(async () => {
    root.render(createElement(Probe));
  });
  return {
    get current() {
      return api;
    },
    async act(fn: () => void) {
      await act(async () => {
        fn();
      });
    },
  };
}

describe("useTableSort", () => {
  it("with initialSort null, preserves input order (no reorder on load)", async () => {
    const hook = await renderHook();
    expect(hook.current.sortedRows.map((r) => r.repName)).toEqual(["Colby", "ana", "Beth"]);
    expect(hook.current.sortState).toBeNull();
  });

  it("first click on a numeric column sorts desc; on a text column sorts asc", async () => {
    const hook = await renderHook();
    await hook.act(() => hook.current.toggle("openDeals"));
    expect(hook.current.sortedRows.map((r) => r.openDeals)).toEqual([100, 10, 9]); // desc
    await hook.act(() => hook.current.toggle("repName"));
    expect(hook.current.sortedRows.map((r) => r.repName)).toEqual(["ana", "Beth", "Colby"]); // asc, case-insensitive
  });

  it("clicking the active column flips direction", async () => {
    const hook = await renderHook();
    await hook.act(() => hook.current.toggle("openDeals")); // desc
    await hook.act(() => hook.current.toggle("openDeals")); // asc
    expect(hook.current.sortedRows.map((r) => r.openDeals)).toEqual([9, 10, 100]);
    expect(hook.current.getHeaderProps("openDeals")).toEqual({ active: true, dir: "asc" });
    expect(hook.current.getHeaderProps("repName")).toEqual({ active: false, dir: null });
  });

  it("honors a provided initialSort on first render", async () => {
    const hook = await renderHook({ initialSort: { key: "openDeals", dir: "desc" } });
    expect(hook.current.sortedRows.map((r) => r.openDeals)).toEqual([100, 10, 9]);
  });

  it("is stable under an active sort: tied keys keep incoming order in both directions", async () => {
    // Three rows sharing the SAME openDeals value — sorting by it must preserve their input order.
    const tied: RepRow[] = [
      { repName: "First", openDeals: 5, pipelineValue: 0, wonThisPeriod: 0, winRate: 0, activityScore: 0 },
      { repName: "Second", openDeals: 5, pipelineValue: 0, wonThisPeriod: 0, winRate: 0, activityScore: 0 },
      { repName: "Third", openDeals: 5, pipelineValue: 0, wonThisPeriod: 0, winRate: 0, activityScore: 0 },
    ];
    const cols: ReadonlyArray<SortColumn<RepRow>> = [{ key: "openDeals", type: "number", accessor: (r) => r.openDeals }];
    const hook = await renderHook(undefined, tied, cols);
    await hook.act(() => hook.current.toggle("openDeals")); // desc
    expect(hook.current.sortedRows.map((r) => r.repName)).toEqual(["First", "Second", "Third"]);
    await hook.act(() => hook.current.toggle("openDeals")); // asc — ties still stable
    expect(hook.current.sortedRows.map((r) => r.repName)).toEqual(["First", "Second", "Third"]);
  });
});
