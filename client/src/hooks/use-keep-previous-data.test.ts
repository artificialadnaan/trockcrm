import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";

import { useKeepPreviousData } from "./use-keep-previous-data";

type Data = { n: number } | null;

describe("useKeepPreviousData", () => {
  it("reports initial loading when no data exists yet (the one time a full skeleton is OK)", () => {
    const { result } = renderHook(() => useKeepPreviousData<Data>(null, true));
    expect(result.current.isInitialLoading).toBe(true);
    expect(result.current.isRefreshing).toBe(false);
    expect(result.current.hasData).toBe(false);
    expect(result.current.data).toBeNull();
  });

  it("exposes data and clears loading once data arrives", () => {
    const data = { n: 1 };
    const { result } = renderHook(({ v, l }) => useKeepPreviousData<Data>(v, l), {
      initialProps: { v: data as Data, l: false },
    });
    expect(result.current.data).toBe(data);
    expect(result.current.isInitialLoading).toBe(false);
    expect(result.current.isRefreshing).toBe(false);
    expect(result.current.hasData).toBe(true);
  });

  it("keeps previous data visible during a background refetch (hook keeps data, loading flips)", () => {
    const first = { n: 1 };
    const { result, rerender } = renderHook(({ v, l }) => useKeepPreviousData<Data>(v, l), {
      initialProps: { v: first as Data, l: false },
    });

    rerender({ v: first as Data, l: true }); // refetch begins; data not nulled
    expect(result.current.data).toBe(first);
    expect(result.current.isInitialLoading).toBe(false);
    expect(result.current.isRefreshing).toBe(true);
  });

  it("keeps previous data even when the source nulls it during a refetch", () => {
    const first = { n: 1 };
    const { result, rerender } = renderHook(({ v, l }) => useKeepPreviousData<Data>(v, l), {
      initialProps: { v: first as Data, l: false },
    });

    rerender({ v: null, l: true }); // source nulled data while loading
    expect(result.current.data).toBe(first); // previous value retained -> no blank
    expect(result.current.isRefreshing).toBe(true);
    expect(result.current.isInitialLoading).toBe(false);
  });

  it("adopts the newest data once the refetch completes", () => {
    const first = { n: 1 };
    const second = { n: 2 };
    const { result, rerender } = renderHook(({ v, l }) => useKeepPreviousData<Data>(v, l), {
      initialProps: { v: first as Data, l: false },
    });

    rerender({ v: null, l: true });
    rerender({ v: second as Data, l: false });
    expect(result.current.data).toBe(second);
    expect(result.current.isRefreshing).toBe(false);
    expect(result.current.hasData).toBe(true);
  });
});
