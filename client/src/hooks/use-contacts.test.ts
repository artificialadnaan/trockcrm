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

const { useContacts } = await import("./use-contacts");

type ContactsResult = ReturnType<typeof useContacts>;

let latest: ContactsResult | null = null;
let currentFilters: Parameters<typeof useContacts>[0] = {};

function Probe() {
  latest = useContacts(currentFilters);
  return null;
}

async function mount() {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(Probe));
  });
  return {
    rerender: async (filters: Parameters<typeof useContacts>[0]) => {
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

describe("useContacts — last-write-wins response sequencing", () => {
  beforeEach(() => {
    latest = null;
    currentFilters = {};
    vi.mocked(api).mockReset();
  });

  it("ignores a stale earlier-keystroke response so it cannot overwrite a later one", async () => {
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

    const page = { page: 1, limit: 50, total: 1, totalPages: 1 };

    // The latest request resolves first.
    await act(async () => {
      resolvers.get("acme")?.({ contacts: [{ id: "acme-c", firstName: "Acme", lastName: "Lead" }], pagination: page });
    });
    expect(latest?.contacts.map((c) => c.id)).toEqual(["acme-c"]);

    // Superseded earlier-keystroke responses arrive LATE — they must NOT overwrite "acme".
    await act(async () => {
      resolvers.get("ac")?.({ contacts: [{ id: "ac-c", firstName: "AC", lastName: "X" }], pagination: page });
    });
    await act(async () => {
      resolvers.get("acm")?.({ contacts: [{ id: "acm-c", firstName: "Acm", lastName: "Y" }], pagination: page });
    });

    expect(latest?.contacts.map((c) => c.id)).toEqual(["acme-c"]);
    unmount();
  });
});
