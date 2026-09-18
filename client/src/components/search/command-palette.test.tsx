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

describe("CommandPalette — the change-order relabel is gated on entityType", () => {
  it("moves 'Change Order N' to the front for a DEAL result", () => {
    setSearchState({
      results: {
        ...fullResults(),
        deals: [r("deal", "d1", "Tides Park Lane — Change Order 2", "/deals/d1")],
      },
      loading: false,
    });
    render();
    const text = container!.textContent ?? "";
    expect(text).toContain("Change Order 2 — Tides Park Lane");
    expect(text).not.toContain("Tides Park Lane — Change Order 2");
  });

  it("leaves a FILE, company, contact, lead or property label byte for byte", () => {
    // This one row renders every entity type. A file a human named "Proposal — Change Order 1" is not a
    // generated deal name, and rewriting it to "Change Order 1 — Proposal" would be a lie about the file.
    setSearchState({
      results: {
        deals: [],
        companies: [r("company", "c1", "Acme — Change Order 1", "/companies/c1")],
        contacts: [],
        leads: [r("lead", "l1", "Lobby — Change Order 1", "/leads/l1")],
        properties: [],
        files: [r("file", "f1", "Proposal — Change Order 1", "/files/f1")],
        total: 3,
        query: "change order",
      },
      loading: false,
    });
    render();
    const text = container!.textContent ?? "";
    expect(text).toContain("Proposal — Change Order 1");
    expect(text).toContain("Acme — Change Order 1");
    expect(text).toContain("Lobby — Change Order 1");
    expect(text).not.toContain("Change Order 1 — Proposal");
    expect(text).not.toContain("Change Order 1 — Acme");
    expect(text).not.toContain("Change Order 1 — Lobby");
  });
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

  it("preserves the backend's active-before-terminal deal order (does not re-sort by rank)", () => {
    const results = {
      ...fullResults(),
      // Backend order: active first, then the (higher-ranked) won deal. A rank-only re-sort
      // would flip these and mix the closed deal in as if it were live.
      deals: [
        r("deal", "active1", "Active Deal", "/deals/active1", { status: "active", rank: 1 }),
        r("deal", "won1", "Won Deal", "/deals/won1", { status: "won", rank: 5 }),
      ],
    };
    setSearchState({ results, loading: false });
    render();
    const text = container!.textContent ?? "";
    expect(text.indexOf("Active Deal")).toBeLessThan(text.indexOf("Won Deal"));
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

  it("renders a deal's amount (right-aligned, compact) and the rep name on the meta line", () => {
    const results = {
      ...fullResults(),
      deals: [
        r("deal", "d1", "Terraces at Highbury Court", "/deals/d1", {
          status: "won",
          secondaryLabel: "DFW-4-16326-af",
          tertiaryLabel: "Atlanta, GA",
          assignedRepName: "Caleb Stone",
          dealValue: "12322.86",
        }),
      ],
    };
    setSearchState({ results, loading: false });
    render();
    const text = container!.textContent ?? "";
    expect(text).toContain("Caleb Stone");
    expect(text).toContain("$12.3K"); // formatCurrencyCompact(12322.86)
    expect(text).toContain("DFW-4-16326-af");
    expect(text).toContain("Atlanta, GA");
  });
});

// The palette is the search page's twin — same `SearchResult` type, same server payload, and the more
// heavily used of the two. scope_title is a MATCHED field, so a hit can be here entirely because of the
// title; showing the name alone answers "here is a result" but never "here is why", which reads as a
// wrong hit (Codex #1051 sweep — the search page got this, the palette did not).
describe("CommandPalette — deal scope title", () => {
  it("shows the scope title on a deal result whose NAME does not contain the match", () => {
    setSearchState({
      results: {
        ...fullResults(),
        deals: [
          r("deal", "d1", "Tides at Highland Meadows — Change Order 1", "/deals/d1", {
            secondaryLabel: "DFW-9-10001-aa",
            isChangeOrder: true,
            scopeTitle: "Panel Relocation",
          }),
        ],
      },
      loading: false,
    });
    render();

    const html = container!.innerHTML;
    expect(html).toContain('data-testid="command-palette-scope-title"');
    expect(container!.textContent).toContain("Panel Relocation");
    // The title sits between the name and the number/location meta line, matching the search page.
    expect(html.indexOf("Panel Relocation")).toBeLessThan(html.indexOf("DFW-9-10001-aa"));
  });

  it("renders nothing extra for a deal with no scope title", () => {
    setSearchState({ results: fullResults(), loading: false });
    render();

    expect(container!.innerHTML).not.toContain('data-testid="command-palette-scope-title"');
    expect(container!.textContent).toContain("Acme Tower"); // the row still renders
  });

  it("does NOT render a scopeTitle that arrives on a non-deal result", () => {
    // One row renders companies, contacts, leads, properties and FILES. The field is deal-only, so the
    // render is gated on entityType exactly like the change-order relabel above it.
    setSearchState({
      results: {
        deals: [],
        companies: [r("company", "c1", "Acme Construction", "/companies/c1", { scopeTitle: "Panel Relocation" })],
        contacts: [],
        leads: [],
        properties: [],
        files: [],
        total: 1,
        query: "panel relocation",
      },
      loading: false,
    });
    render();

    expect(container!.textContent).toContain("Acme Construction");
    expect(container!.textContent).not.toContain("Panel Relocation");
  });
});
