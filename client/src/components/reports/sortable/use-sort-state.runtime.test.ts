// @vitest-environment jsdom
import { afterEach, describe, it, expect } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  useSortState,
  ariaSort,
  type SortStateColumn,
  type UseSortStateOptions,
  type UseSortStateResult,
} from "./use-sort-state";

// The state machine the server-side list pages share with useTableSort: one active {key,dir}, a toggle
// that flips the active key and otherwise switches at the column type's default direction, and header props.
const COLUMNS: ReadonlyArray<SortStateColumn> = [
  { key: "name", type: "text" },
  { key: "value", type: "number" },
  { key: "created", type: "date" },
];

const mountedRoots: Array<{ unmount: () => void; remove: () => void }> = [];
afterEach(() => {
  for (const r of mountedRoots.splice(0)) {
    act(() => r.unmount());
    r.remove();
  }
});

async function renderHook(options?: UseSortStateOptions) {
  const container = document.createElement("div");
  const root = createRoot(container);
  mountedRoots.push({ unmount: () => root.unmount(), remove: () => container.remove() });
  let api: UseSortStateResult;
  function Probe() {
    api = useSortState(COLUMNS, options);
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

describe("useSortState", () => {
  it("starts unsorted by default and seeds from initialSort", async () => {
    const a = await renderHook();
    expect(a.current.sortState).toBeNull();
    const b = await renderHook({ initialSort: { key: "value", dir: "desc" } });
    expect(b.current.sortState).toEqual({ key: "value", dir: "desc" });
  });

  it("toggling a new column uses the type's default direction (text→asc, number/date→desc)", async () => {
    const h = await renderHook();
    await h.act(() => h.current.toggle("name"));
    expect(h.current.sortState).toEqual({ key: "name", dir: "asc" });
    await h.act(() => h.current.toggle("value"));
    expect(h.current.sortState).toEqual({ key: "value", dir: "desc" });
    await h.act(() => h.current.toggle("created"));
    expect(h.current.sortState).toEqual({ key: "created", dir: "desc" });
  });

  it("toggling the active column flips direction", async () => {
    const h = await renderHook({ initialSort: { key: "name", dir: "asc" } });
    await h.act(() => h.current.toggle("name"));
    expect(h.current.sortState).toEqual({ key: "name", dir: "desc" });
    await h.act(() => h.current.toggle("name"));
    expect(h.current.sortState).toEqual({ key: "name", dir: "asc" });
  });

  it("toggling an unknown key is a no-op", async () => {
    const h = await renderHook({ initialSort: { key: "name", dir: "asc" } });
    await h.act(() => h.current.toggle("nope"));
    expect(h.current.sortState).toEqual({ key: "name", dir: "asc" });
  });

  it("getHeaderProps reports active+dir only for the active column", async () => {
    const h = await renderHook({ initialSort: { key: "value", dir: "desc" } });
    expect(h.current.getHeaderProps("value")).toEqual({ active: true, dir: "desc" });
    expect(h.current.getHeaderProps("name")).toEqual({ active: false, dir: null });
  });
});

describe("ariaSort", () => {
  it("maps active+dir to the aria-sort token; inactive/null → none", () => {
    expect(ariaSort(true, "asc")).toBe("ascending");
    expect(ariaSort(true, "desc")).toBe("descending");
    expect(ariaSort(false, "asc")).toBe("none");
    expect(ariaSort(true, null)).toBe("none");
  });
});
