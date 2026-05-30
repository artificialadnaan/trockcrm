// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";

import { type KeepPreviousDataResult, useKeepPreviousData } from "./use-keep-previous-data";

type Data = { n: number } | null;

// Repo convention (see use-deals.test.ts): hand-rolled renderHook via createRoot + act.
async function renderKeep(initial: { value: Data; loading: boolean }) {
  const container = document.createElement("div");
  const root = createRoot(container);
  const state = { ...initial };
  let latest: KeepPreviousDataResult<Data> | null = null;

  function Probe() {
    latest = useKeepPreviousData<Data>(state.value, state.loading);
    return null;
  }

  await act(async () => {
    root.render(createElement(Probe));
  });

  return {
    get current(): KeepPreviousDataResult<Data> {
      if (!latest) throw new Error("hook did not render");
      return latest;
    },
    async set(next: { value: Data; loading: boolean }) {
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

describe("useKeepPreviousData", () => {
  it("reports initial loading when no data exists yet (the one time a full skeleton is OK)", async () => {
    const hook = await renderKeep({ value: null, loading: true });
    expect(hook.current.isInitialLoading).toBe(true);
    expect(hook.current.isRefreshing).toBe(false);
    expect(hook.current.hasData).toBe(false);
    expect(hook.current.data).toBeNull();
    hook.unmount();
  });

  it("exposes data and clears loading once data arrives", async () => {
    const data = { n: 1 };
    const hook = await renderKeep({ value: data, loading: false });
    expect(hook.current.data).toBe(data);
    expect(hook.current.isInitialLoading).toBe(false);
    expect(hook.current.isRefreshing).toBe(false);
    expect(hook.current.hasData).toBe(true);
    hook.unmount();
  });

  it("keeps previous data visible during a background refetch (data kept, loading flips)", async () => {
    const first = { n: 1 };
    const hook = await renderKeep({ value: first, loading: false });
    await hook.set({ value: first, loading: true }); // refetch begins; data not nulled
    expect(hook.current.data).toBe(first);
    expect(hook.current.isInitialLoading).toBe(false);
    expect(hook.current.isRefreshing).toBe(true);
    hook.unmount();
  });

  it("keeps previous data even when the source nulls it during a refetch", async () => {
    const first = { n: 1 };
    const hook = await renderKeep({ value: first, loading: false });
    await hook.set({ value: null, loading: true }); // source nulled data while loading
    expect(hook.current.data).toBe(first); // previous value retained -> no blank
    expect(hook.current.isRefreshing).toBe(true);
    expect(hook.current.isInitialLoading).toBe(false);
    hook.unmount();
  });

  it("adopts the newest data once the refetch completes", async () => {
    const first = { n: 1 };
    const second = { n: 2 };
    const hook = await renderKeep({ value: first, loading: false });
    await hook.set({ value: null, loading: true });
    await hook.set({ value: second, loading: false });
    expect(hook.current.data).toBe(second);
    expect(hook.current.isRefreshing).toBe(false);
    expect(hook.current.hasData).toBe(true);
    hook.unmount();
  });
});
