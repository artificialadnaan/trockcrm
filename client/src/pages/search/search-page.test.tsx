// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { SearchPage } from "./search-page";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  useSearchMock: vi.fn(),
  useAiSearchMock: vi.fn(),
  useRecentSearchesMock: vi.fn(),
  trackAiSearchInteractionMock: vi.fn(),
}));

vi.mock("@/hooks/use-search", () => ({
  useSearch: mocks.useSearchMock,
  useAiSearch: mocks.useAiSearchMock,
  useRecentSearches: mocks.useRecentSearchesMock,
  trackAiSearchInteraction: mocks.trackAiSearchInteractionMock,
  executeAiSearchWorkflowAction: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

function hit(entityType: string, id: string, primaryLabel: string, deepLink: string, extra: Record<string, unknown> = {}) {
  return { entityType, id, primaryLabel, secondaryLabel: "", deepLink, rank: 1, ...extra };
}

function emptyStructured(total: number) {
  return { deals: [], contacts: [], files: [], companies: [], leads: [], properties: [], total, query: "acme" };
}

function aiResults(opts: { summary: string; total: number; evidence?: unknown[] }) {
  return {
    queryId: "q1",
    query: "acme",
    intent: "general_search",
    summary: opts.summary,
    structured: emptyStructured(opts.total),
    topEntities: [],
    recommendedActions: [],
    evidence: opts.evidence ?? [],
  };
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

describe("SearchPage — AI summary never contradicts the rendered entity groups", () => {
  function renderWith(structuredResults: Record<string, unknown>, ai: ReturnType<typeof aiResults> | null) {
    mocks.useRecentSearchesMock.mockReturnValue({ recent: [], addRecent: vi.fn(), clearRecent: vi.fn() });
    mocks.useAiSearchMock.mockReturnValue({ query: "acme", setQuery: vi.fn(), results: ai, loading: false });
    mocks.useSearchMock.mockReturnValue({ query: "acme", setQuery: vi.fn(), loading: false, error: null, results: structuredResults });
    return renderToStaticMarkup(
      <MemoryRouter initialEntries={["/search?q=acme"]}>
        <SearchPage />
      </MemoryRouter>,
    );
  }

  it("suppresses the AI 'no matches' card when the page renders company/lead/property cards", () => {
    // /search/ai only searches deals/contacts/files -> total 0 here, but the page found a company.
    const html = renderWith(
      {
        deals: [], companies: [hit("company", "c1", "Acme Construction", "/companies/c1")],
        contacts: [], leads: [], properties: [], files: [], total: 1, query: "acme",
      },
      aiResults({ summary: 'No CRM matches or indexed evidence were found for "acme".', total: 0, evidence: [] }),
    );
    expect(html).toContain("Acme Construction"); // the real match still renders
    expect(html).not.toContain("AI Search Summary"); // the contradictory AI card is suppressed
  });

  it("still shows the AI card when the AI path actually found something", () => {
    const html = renderWith(
      {
        deals: [hit("deal", "d1", "Acme Tower", "/deals/d1")],
        companies: [], contacts: [], leads: [], properties: [], files: [], total: 1, query: "acme",
      },
      aiResults({ summary: "Found 1 structured CRM match across 1 deal.", total: 1 }),
    );
    expect(html).toContain("AI Search Summary");
  });
});

describe("SearchPage — AI impression is logged only when the card actually renders", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) act(() => root!.unmount());
    container?.remove();
    root = null;
    container = null;
    vi.clearAllMocks();
  });

  async function mount(structuredResults: Record<string, unknown>, ai: ReturnType<typeof aiResults>) {
    mocks.useRecentSearchesMock.mockReturnValue({ recent: [], addRecent: vi.fn(), clearRecent: vi.fn() });
    mocks.useAiSearchMock.mockReturnValue({ query: "acme", setQuery: vi.fn(), results: ai, loading: false });
    mocks.useSearchMock.mockReturnValue({ query: "acme", setQuery: vi.fn(), loading: false, error: null, results: structuredResults });
    mocks.trackAiSearchInteractionMock.mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container!);
      root.render(
        <MemoryRouter initialEntries={["/search?q=acme"]}>
          <SearchPage />
        </MemoryRouter>,
      );
    });
  }

  it("does NOT log an impression when the AI card is suppressed (company-only query)", async () => {
    await mount(
      { deals: [], companies: [hit("company", "c1", "Acme Construction", "/companies/c1")], contacts: [], leads: [], properties: [], files: [], total: 1, query: "acme" },
      aiResults({ summary: 'No CRM matches or indexed evidence were found for "acme".', total: 0, evidence: [] }),
    );
    // Card suppressed -> the served-impression must NOT fire (keeps admin AI-Ops metrics honest).
    expect(mocks.trackAiSearchInteractionMock).not.toHaveBeenCalled();
  });

  it("logs a search_impression when the AI card actually renders", async () => {
    await mount(
      { deals: [hit("deal", "d1", "Acme Tower", "/deals/d1")], companies: [], contacts: [], leads: [], properties: [], files: [], total: 1, query: "acme" },
      aiResults({ summary: "Found 1 structured CRM match across 1 deal.", total: 1 }),
    );
    expect(mocks.trackAiSearchInteractionMock).toHaveBeenCalledTimes(1);
    expect(mocks.trackAiSearchInteractionMock.mock.calls[0][0]).toMatchObject({ interactionType: "search_impression" });
  });
});
