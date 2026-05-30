// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  api: vi.fn(),
  getCsrfToken: () => undefined,
  resolveApiBase: () => "/api",
}));

import { api } from "@/lib/api";

const { useSearch } = await import("./use-search");

type SearchHook = ReturnType<typeof useSearch>;

let latest: SearchHook | null = null;

function Probe() {
  latest = useSearch();
  return null;
}

async function mount() {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(Probe));
  });
  return { unmount: () => act(() => root.unmount()) };
}

function emptyResponse(query: string) {
  return { deals: [], contacts: [], files: [], companies: [], leads: [], properties: [], total: 0, query };
}

function qOf(path: string) {
  return new URLSearchParams(path.split("?")[1] ?? "").get("q") ?? "";
}

describe("useSearch", () => {
  beforeEach(() => {
    latest = null;
    vi.mocked(api).mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-keys the search AT MOST ONCE after the debounce window, not once per keystroke", async () => {
    vi.mocked(api).mockImplementation(async (path: string) => emptyResponse(qOf(path as string)));
    const { unmount } = await mount();

    act(() => latest!.setQuery("a"));
    act(() => latest!.setQuery("ac"));
    act(() => latest!.setQuery("acm"));

    expect(api).not.toHaveBeenCalled(); // nothing fired mid-type (and "a" is under the 2-char floor)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(api).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(api).mock.calls[0]?.[0])).toContain("q=acm");
    unmount();
  });

  it("ignores a stale earlier-keystroke response so it cannot overwrite a later one", async () => {
    const resolvers = new Map<string, (value: unknown) => void>();
    vi.mocked(api).mockImplementation(
      (path: string) => new Promise((resolve) => resolvers.set(qOf(path as string), resolve)),
    );
    const { unmount } = await mount();

    // First debounced query "ac" goes in flight.
    act(() => latest!.setQuery("ac"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    // Second debounced query "acme" goes in flight (the latest).
    act(() => latest!.setQuery("acme"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    // The latest resolves first.
    await act(async () => {
      resolvers.get("acme")?.(emptyResponse("acme"));
    });
    expect(latest!.results?.query).toBe("acme");

    // The superseded earlier response arrives LATE -- it must NOT overwrite "acme".
    await act(async () => {
      resolvers.get("ac")?.(emptyResponse("ac"));
    });
    expect(latest!.results?.query).toBe("acme");
    unmount();
  });
});
