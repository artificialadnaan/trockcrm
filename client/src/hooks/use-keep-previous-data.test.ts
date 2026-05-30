// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";

import { type KeepPreviousDataResult, useKeepPreviousData } from "./use-keep-previous-data";

// Repo convention (see use-deals.test.ts): hand-rolled renderHook via createRoot + act.
async function renderKeep<V>(initial: { value: V; loading: boolean }) {
  const container = document.createElement("div");
  const root = createRoot(container);
  const state = { value: initial.value, loading: initial.loading };
  let latest: KeepPreviousDataResult<V> | null = null;

  function Probe() {
    latest = useKeepPreviousData<V>(state.value, state.loading);
    return null;
  }

  await act(async () => {
    root.render(createElement(Probe));
  });

  return {
    get current(): KeepPreviousDataResult<V> {
      if (!latest) throw new Error("hook did not render");
      return latest;
    },
    async set(next: { value: V; loading: boolean }) {
      state.value = next.value;
      state.loading = next.loading;
      await act(async () => {
        root.render(createElement(Probe));
      });
    },
    unmount() {
      root.unmount();
    },
  };
}

type Obj = { n: number } | null;

describe("useKeepPreviousData", () => {
  it("reports initial loading when no data exists yet (the one time a full skeleton is OK)", async () => {
    const hook = await renderKeep<Obj>({ value: null, loading: true });
    expect(hook.current.isInitialLoading).toBe(true);
    expect(hook.current.isRefreshing).toBe(false);
    expect(hook.current.hasData).toBe(false);
    expect(hook.current.data).toBeNull();
    hook.unmount();
  });

  it("exposes data and clears loading once data arrives", async () => {
    const data = { n: 1 };
    const hook = await renderKeep<Obj>({ value: data, loading: false });
    expect(hook.current.data).toBe(data);
    expect(hook.current.isInitialLoading).toBe(false);
    expect(hook.current.isRefreshing).toBe(false);
    expect(hook.current.hasData).toBe(true);
    hook.unmount();
  });

  it("keeps previous data visible during a background refetch (data kept, loading flips)", async () => {
    const first = { n: 1 };
    const hook = await renderKeep<Obj>({ value: first, loading: false });
    await hook.set({ value: first, loading: true });
    expect(hook.current.data).toBe(first);
    expect(hook.current.isInitialLoading).toBe(false);
    expect(hook.current.isRefreshing).toBe(true);
    hook.unmount();
  });

  it("keeps previous data ONLY while the refetch is in flight, even if the source nulls it", async () => {
    const first = { n: 1 };
    const hook = await renderKeep<Obj>({ value: first, loading: false });
    await hook.set({ value: null, loading: true }); // source nulled data WHILE loading
    expect(hook.current.data).toBe(first); // retained -> no blank during refetch
    expect(hook.current.isRefreshing).toBe(true);
    expect(hook.current.isInitialLoading).toBe(false);
    hook.unmount();
  });

  it("shows a SETTLED nullish result instead of stale data (no infinite stale retention)", async () => {
    const first = { n: 1 };
    const hook = await renderKeep<Obj>({ value: first, loading: false });
    await hook.set({ value: null, loading: false }); // fetch COMPLETED with no data
    expect(hook.current.data).toBeNull(); // not the stale `first`
    expect(hook.current.hasData).toBe(false);
    expect(hook.current.isRefreshing).toBe(false);
    expect(hook.current.isInitialLoading).toBe(false);
    hook.unmount();
  });

  it("adopts the newest data once the refetch completes", async () => {
    const first = { n: 1 };
    const second = { n: 2 };
    const hook = await renderKeep<Obj>({ value: first, loading: false });
    await hook.set({ value: null, loading: true });
    await hook.set({ value: second, loading: false });
    expect(hook.current.data).toBe(second);
    expect(hook.current.isRefreshing).toBe(false);
    expect(hook.current.hasData).toBe(true);
    hook.unmount();
  });

  it("treats an initial empty-array placeholder as initial loading (not loaded data)", async () => {
    const hook = await renderKeep<number[]>({ value: [], loading: true });
    expect(hook.current.isInitialLoading).toBe(true); // first skeleton, not an empty-state flash
    expect(hook.current.isRefreshing).toBe(false);
    await hook.set({ value: [1, 2], loading: false });
    expect(hook.current.isInitialLoading).toBe(false);
    expect(hook.current.data).toEqual([1, 2]);
    hook.unmount();
  });

  it("after the first load settles, a genuinely empty result is shown (not a skeleton)", async () => {
    const hook = await renderKeep<number[]>({ value: [], loading: true });
    await hook.set({ value: [], loading: false }); // settled with zero results
    expect(hook.current.isInitialLoading).toBe(false);
    expect(hook.current.data).toEqual([]);
    hook.unmount();
  });

  it("stays in initial-loading on a retry after the FIRST fetch failed with no data", async () => {
    const hook = await renderKeep<Obj>({ value: null, loading: true });
    expect(hook.current.isInitialLoading).toBe(true); // first fetch in flight
    await hook.set({ value: null, loading: false }); // first fetch FAILED -> no data
    expect(hook.current.isInitialLoading).toBe(false); // settled (page shows its error)
    await hook.set({ value: null, loading: true }); // user hits Retry
    // A failed completion did not produce data, so this is still effectively the first
    // load -> show the skeleton, NOT a blank.
    expect(hook.current.isInitialLoading).toBe(true);
    expect(hook.current.isRefreshing).toBe(false);
    await hook.set({ value: { n: 1 }, loading: false }); // retry succeeds
    expect(hook.current.isInitialLoading).toBe(false);
    expect(hook.current.data).toEqual({ n: 1 });
    hook.unmount();
  });
});
