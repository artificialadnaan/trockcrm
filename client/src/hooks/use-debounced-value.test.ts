import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { DEFAULT_SEARCH_DEBOUNCE_MS, useDebouncedValue } from "./use-debounced-value";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useDebouncedValue", () => {
  it("returns the initial value immediately", () => {
    const { result } = renderHook(() => useDebouncedValue("a", 300));
    expect(result.current).toBe("a");
  });

  it("does not update until the delay elapses, then emits the latest value", () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 300), {
      initialProps: { v: "a" },
    });

    rerender({ v: "ab" });
    rerender({ v: "abc" });
    expect(result.current).toBe("a"); // unchanged before the delay

    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(result.current).toBe("a");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe("abc"); // only the final value lands, after 300ms
  });

  it("resets the timer on every change so only the settled value is emitted", () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 300), {
      initialProps: { v: "a" },
    });

    rerender({ v: "ab" });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    rerender({ v: "abc" }); // resets the timer with 200ms already elapsed
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current).toBe("a"); // 200ms since last change < 300ms

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBe("abc");
  });

  it("uses the shared default debounce when the delay is omitted", () => {
    expect(DEFAULT_SEARCH_DEBOUNCE_MS).toBe(300);
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v), {
      initialProps: { v: "x" },
    });

    rerender({ v: "xy" });
    act(() => {
      vi.advanceTimersByTime(DEFAULT_SEARCH_DEBOUNCE_MS);
    });
    expect(result.current).toBe("xy");
  });

  it("passes the value through immediately when the delay is <= 0", () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 0), {
      initialProps: { v: "a" },
    });

    rerender({ v: "b" });
    expect(result.current).toBe("b");
  });
});
