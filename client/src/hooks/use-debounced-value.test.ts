// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SEARCH_DEBOUNCE_MS, useDebouncedValue } from "./use-debounced-value";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// Repo convention (see use-deals.test.ts): hand-rolled renderHook via createRoot + act,
// no @testing-library. The component lives only to run the hook and capture its return.
async function renderDebounced(initialValue: string, delayMs?: number) {
  const container = document.createElement("div");
  const root = createRoot(container);
  const state = { value: initialValue, delayMs };
  let latest = "";

  function Probe() {
    latest = useDebouncedValue(state.value, state.delayMs);
    return null;
  }

  await act(async () => {
    root.render(createElement(Probe));
  });

  return {
    get current() {
      return latest;
    },
    async setValue(value: string) {
      state.value = value;
      await act(async () => {
        root.render(createElement(Probe));
      });
    },
    async advance(ms: number) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    },
    unmount() {
      root.unmount();
    },
  };
}

describe("useDebouncedValue", () => {
  it("returns the initial value immediately", async () => {
    const hook = await renderDebounced("a", 300);
    expect(hook.current).toBe("a");
    hook.unmount();
  });

  it("does not update until the delay elapses, then emits the latest value", async () => {
    const hook = await renderDebounced("a", 300);
    await hook.setValue("ab");
    await hook.setValue("abc");
    expect(hook.current).toBe("a"); // unchanged before the delay

    await hook.advance(299);
    expect(hook.current).toBe("a");

    await hook.advance(1);
    expect(hook.current).toBe("abc"); // only the final value lands, after 300ms
    hook.unmount();
  });

  it("resets the timer on every change so only the settled value is emitted", async () => {
    const hook = await renderDebounced("a", 300);
    await hook.setValue("ab");
    await hook.advance(200);
    await hook.setValue("abc"); // resets the timer with 200ms already elapsed
    await hook.advance(200);
    expect(hook.current).toBe("a"); // 200ms since last change < 300ms

    await hook.advance(100);
    expect(hook.current).toBe("abc");
    hook.unmount();
  });

  it("uses the shared default debounce when the delay is omitted", async () => {
    expect(DEFAULT_SEARCH_DEBOUNCE_MS).toBe(300);
    const hook = await renderDebounced("x");
    await hook.setValue("xy");
    await hook.advance(DEFAULT_SEARCH_DEBOUNCE_MS);
    expect(hook.current).toBe("xy");
    hook.unmount();
  });

  it("passes the value through immediately when the delay is <= 0", async () => {
    const hook = await renderDebounced("a", 0);
    await hook.setValue("b");
    expect(hook.current).toBe("b");
    hook.unmount();
  });
});
