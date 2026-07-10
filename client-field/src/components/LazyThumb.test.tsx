/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LazyThumb } from "./LazyThumb";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
});

async function render(ui: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(ui);
  });
  return container!;
}

describe("LazyThumb", () => {
  it("defers the <img> until the element scrolls into view, then loads its src and stops observing", async () => {
    // Controllable IntersectionObserver: capture the callback so the test can drive intersection on demand.
    let trigger: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null;
    const disconnect = vi.fn();
    class MockIO {
      constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) { trigger = cb; }
      observe() {}
      disconnect = disconnect;
      unobserve() {}
      takeRecords() { return []; }
    }
    vi.stubGlobal("IntersectionObserver", MockIO as unknown as typeof IntersectionObserver);

    const node = await render(<LazyThumb src="https://example.com/a.jpg" alt="A" />);
    // Off-screen: no <img> mounted, so no thumbnail request fires (this is what prevents the request flood).
    expect(node.querySelector("img")).toBeNull();

    // Scroll it into view.
    await act(async () => { trigger?.([{ isIntersecting: true }]); });
    const img = node.querySelector("img");
    expect(img).toBeTruthy();
    expect(img?.getAttribute("src")).toBe("https://example.com/a.jpg");
    expect(disconnect).toHaveBeenCalled(); // one-shot: stops observing after it loads
  });

  it("loads eagerly when IntersectionObserver is unavailable (graceful fallback)", async () => {
    vi.stubGlobal("IntersectionObserver", undefined as unknown as typeof IntersectionObserver);
    const node = await render(<LazyThumb src="https://example.com/b.jpg" alt="B" />);
    const img = node.querySelector("img");
    expect(img).toBeTruthy();
    expect(img?.getAttribute("src")).toBe("https://example.com/b.jpg");
  });
});
