// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";

import { CommandPalette } from "./command-palette";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  useSearchMock: vi.fn(),
  useRecentSearchesMock: vi.fn(),
}));

vi.mock("@/hooks/use-search", () => ({
  useSearch: mocks.useSearchMock,
  useRecentSearches: mocks.useRecentSearchesMock,
}));

function r(entityType: string, id: string, primaryLabel: string, deepLink: string, extra: Record<string, unknown> = {}) {
  return { entityType, id, primaryLabel, secondaryLabel: "", deepLink, rank: 1, ...extra };
}

function fullResults() {
  return {
    deals: [r("deal", "d1", "Acme Tower", "/deals/d1", { status: "won" })],
    companies: [r("company", "c1", "Acme Construction", "/companies/c1")],
    contacts: [r("contact", "ct1", "Maria Acme", "/contacts/ct1")],
    leads: [r("lead", "l1", "Acme Roof Lead", "/leads/l1")],
    properties: [r("property", "p1", "Acme HQ", "/properties/p1")],
    files: [],
    total: 5,
    query: "acme",
  };
}

let capturedLocation = "";
function LocationProbe() {
  capturedLocation = `${useLocation().pathname}`;
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function setSearchState(state: { query?: string; results?: unknown; loading?: boolean }) {
  mocks.useSearchMock.mockReturnValue({
    query: state.query ?? "acme",
    setQuery: vi.fn(),
    results: state.results ?? null,
    loading: state.loading ?? false,
    error: null,
  });
}

function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container!);
    root.render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <LocationProbe />
        <CommandPalette open onClose={vi.fn()} />
      </MemoryRouter>,
    );
  });
}

beforeEach(() => {
  document.body.innerHTML = "";
  capturedLocation = "";
  mocks.useSearchMock.mockReset();
  mocks.useRecentSearchesMock.mockReset();
  mocks.useRecentSearchesMock.mockReturnValue({ recent: [], addRecent: vi.fn(), clearRecent: vi.fn() });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("CommandPalette — unified grouped, no-blank search UX", () => {
  it("groups results by entity type and marks won deals", () => {
    setSearchState({ results: fullResults(), loading: false });
    render();
    const text = container!.textContent ?? "";
    // All five business entity groups render with headers.
    for (const header of ["Deals", "Accounts", "Contacts", "Leads", "Properties"]) {
      expect(text).toContain(header);
    }
    // Entities the old global search missed are present.
    expect(text).toContain("Acme Construction");
    expect(text).toContain("Acme Roof Lead");
    expect(text).toContain("Acme HQ");
    // Won deal is findable AND marked.
    expect(text).toContain("Won");
  });

  it("keeps the previous results mounted during a refetch (no blank/flash)", () => {
    setSearchState({ results: fullResults(), loading: true }); // refetch in flight, prior results present
    render();
    const text = container!.textContent ?? "";
    expect(text).toContain("Acme Tower"); // prior results still shown
    expect(text).not.toContain("Searching..."); // not replaced by the empty loading state
    expect(text).toContain("Updating"); // subtle refresh hint instead
  });

  it("does not navigate while typing; navigates only when a result is selected", () => {
    setSearchState({ results: fullResults(), loading: false });
    render();
    expect(capturedLocation).toBe("/dashboard");

    // Typing in the search box must not navigate.
    const input = container!.querySelector("input")!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "acme towers");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(capturedLocation).toBe("/dashboard"); // no nav on keystroke

    // Selecting a result navigates to its deep link.
    const dealButton = Array.from(container!.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Acme Tower"),
    )!;
    act(() => dealButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(capturedLocation).toBe("/deals/d1");
  });
});
