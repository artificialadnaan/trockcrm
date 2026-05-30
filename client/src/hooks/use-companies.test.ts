// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  api: vi.fn(),
  getCsrfToken: () => undefined,
  resolveApiBase: () => "/api",
}));

import { api } from "@/lib/api";

const { useCompanies } = await import("./use-companies");

type CompaniesResult = ReturnType<typeof useCompanies>;

let latest: CompaniesResult | null = null;
let currentFilters: Parameters<typeof useCompanies>[0] = {};

function Probe() {
  latest = useCompanies(currentFilters);
  return null;
}

async function mount() {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(Probe));
  });
  return {
    rerender: async (filters: Parameters<typeof useCompanies>[0]) => {
      currentFilters = filters;
      await act(async () => {
        root.render(createElement(Probe));
      });
    },
    unmount: () => act(() => root.unmount()),
  };
}

function searchOf(path: string) {
  return new URLSearchParams(path.split("?")[1] ?? "").get("search") ?? "";
}

describe("useCompanies — last-write-wins response sequencing", () => {
  beforeEach(() => {
    latest = null;
    currentFilters = {};
    vi.mocked(api).mockReset();
  });

  it("ignores a stale earlier-keystroke response so it cannot overwrite a later one", async () => {
    // Each request resolves only when the test hands it a value, keyed by its search term.
    const resolvers = new Map<string, (value: unknown) => void>();
    vi.mocked(api).mockImplementation((path: string) => {
      return new Promise((resolve) => {
        resolvers.set(searchOf(path), resolve);
      });
    });

    currentFilters = { search: "ac" };
    const { rerender, unmount } = await mount(); // fetch("ac") in flight
    await rerender({ search: "acm" }); // fetch("acm") in flight
    await rerender({ search: "acme" }); // fetch("acme") in flight — the LATEST

    // The latest request resolves first.
    await act(async () => {
      resolvers.get("acme")?.({ companies: [{ id: "acme-co", name: "Acme" }], total: 1, page: 1, limit: 50 });
    });
    expect(latest?.companies.map((c) => c.id)).toEqual(["acme-co"]);

    // The superseded earlier-keystroke responses arrive LATE — they must NOT overwrite "acme".
    await act(async () => {
      resolvers.get("ac")?.({ companies: [{ id: "ac-co", name: "AC" }], total: 1, page: 1, limit: 50 });
    });
    await act(async () => {
      resolvers.get("acm")?.({ companies: [{ id: "acm-co", name: "Acm" }], total: 1, page: 1, limit: 50 });
    });

    expect(latest?.companies.map((c) => c.id)).toEqual(["acme-co"]);
    unmount();
  });
});
