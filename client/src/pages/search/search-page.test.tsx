// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { SearchPage } from "./search-page";

const mocks = vi.hoisted(() => ({
  useSearchMock: vi.fn(),
  useAiSearchMock: vi.fn(),
  useRecentSearchesMock: vi.fn(),
}));

vi.mock("@/hooks/use-search", () => ({
  useSearch: mocks.useSearchMock,
  useAiSearch: mocks.useAiSearchMock,
  useRecentSearches: mocks.useRecentSearchesMock,
  trackAiSearchInteraction: vi.fn(),
  executeAiSearchWorkflowAction: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

function hit(entityType: string, id: string, primaryLabel: string, deepLink: string, extra: Record<string, unknown> = {}) {
  return { entityType, id, primaryLabel, secondaryLabel: "", deepLink, rank: 1, ...extra };
}

describe("SearchPage — renders the unified entity groups (PR5)", () => {
  it("renders companies, leads and properties groups + Won markers, not just deals/contacts/files", () => {
    mocks.useRecentSearchesMock.mockReturnValue({ recent: [], addRecent: vi.fn(), clearRecent: vi.fn() });
    mocks.useAiSearchMock.mockReturnValue({ query: "", setQuery: vi.fn(), results: null, loading: false });
    mocks.useSearchMock.mockReturnValue({
      query: "acme",
      setQuery: vi.fn(),
      loading: false,
      error: null,
      results: {
        deals: [hit("deal", "d1", "Acme Tower", "/deals/d1", { status: "won" })],
        companies: [hit("company", "c1", "Acme Construction", "/companies/c1")],
        contacts: [],
        leads: [hit("lead", "l1", "Acme Roof Lead", "/leads/l1")],
        properties: [hit("property", "p1", "Acme HQ", "/properties/p1")],
        files: [],
        total: 4,
        query: "acme",
      },
    });

    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/search?q=acme"]}>
        <SearchPage />
      </MemoryRouter>,
    );

    // The three groups the page previously dropped now render.
    expect(html).toContain("Acme Construction");
    expect(html).toContain("Acme Roof Lead");
    expect(html).toContain("Acme HQ");
    // Group headers + the Won lifecycle marker.
    expect(html).toContain("Accounts");
    expect(html).toContain("Leads");
    expect(html).toContain("Properties");
    expect(html).toContain("Won");
  });
});
