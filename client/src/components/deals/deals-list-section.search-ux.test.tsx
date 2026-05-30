// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { DealsListSection } from "./deals-list-section";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  useDealsMock: vi.fn(),
  usePipelineStagesMock: vi.fn(),
  useTaskAssigneesMock: vi.fn(),
  apiMock: vi.fn(),
}));

vi.mock("@/hooks/use-deals", () => ({ useDeals: mocks.useDealsMock }));
vi.mock("@/hooks/use-pipeline-config", () => ({ usePipelineStages: mocks.usePipelineStagesMock }));
vi.mock("@/hooks/use-task-assignees", () => ({ useTaskAssignees: mocks.useTaskAssigneesMock }));
vi.mock("@/lib/api", () => ({ api: mocks.apiMock }));

// Plain input so typing via the native value setter behaves predictably; the real
// SearchInput (with its useDebouncedValue) is exercised unmocked — that is the unit
// under test.
vi.mock("@/components/ui/input", () => ({
  Input: (props: Record<string, unknown>) => <input {...props} />,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div data-mock-select>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectValue: ({ children, placeholder }: { children?: ReactNode; placeholder?: string }) => (
    <span>{children ?? placeholder ?? ""}</span>
  ),
}));

vi.mock("@/components/pipeline/terminal-date-filter-control", () => ({
  TerminalDateFilterControl: () => <div data-mock-date-filter />,
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn() } }));

const SEARCH_PLACEHOLDER = "Search deals or accounts";

function makeDeal(overrides: Record<string, unknown> = {}) {
  return {
    id: "deal-1",
    dealNumber: "HS-1",
    projectNumber: "DFW-1",
    name: "Palm Villas",
    stageId: "stage-opportunity",
    stageName: "Opportunity",
    stageSlug: "opportunity",
    assignedRepId: "rep-1",
    assignedRepName: "Brett Jones",
    companyId: "company-1",
    companyName: "Acme Construction",
    propertyAddress: null,
    propertyCity: "Dallas",
    propertyState: "TX",
    description: null,
    isActive: true,
    lastActivityAt: "2026-04-21T10:00:00.000Z",
    stageEnteredAt: "2026-04-10T10:00:00.000Z",
    createdAt: "2026-04-09T10:00:00.000Z",
    updatedAt: "2026-04-20T10:00:00.000Z",
    ...overrides,
  };
}

function settledDeals(deals = [makeDeal()]) {
  return { deals, pagination: { page: 1, limit: 25, total: deals.length, totalPages: 1 }, loading: false, error: null, refetch: vi.fn() };
}

function refetchingDeals(deals = [makeDeal()]) {
  return { deals, pagination: { page: 1, limit: 25, total: deals.length, totalPages: 1 }, loading: true, error: null, refetch: vi.fn() };
}

function setNativeInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

let capturedLocation = "";
function LocationProbe() {
  const location = useLocation();
  capturedLocation = `${location.pathname}${location.search}`;
  return null;
}

function mountSection(initialEntry = "/deals", extraProps: Record<string, unknown> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  const tree = () => (
    <MemoryRouter initialEntries={[initialEntry]}>
      <LocationProbe />
      <DealsListSection searchPlaceholder={SEARCH_PLACEHOLDER} pageSize={25} {...extraProps} />
    </MemoryRouter>
  );
  act(() => {
    root = createRoot(container);
    root.render(tree());
  });
  return {
    container,
    rerender: () => {
      act(() => {
        root.render(tree());
      });
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function searchInput(container: HTMLElement) {
  const input = container.querySelector<HTMLInputElement>(`input[placeholder="${SEARCH_PLACEHOLDER}"]`);
  if (!input) throw new Error("search input not found");
  return input;
}

function searchValuesSentToHook() {
  return mocks.useDealsMock.mock.calls
    .map((call) => (call[0] as { search?: string } | undefined)?.search ?? "")
    .filter((value) => value.length > 0);
}

describe("DealsListSection — debounced, no-blank search UX (hard frontend requirement)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    mocks.useDealsMock.mockReset();
    mocks.usePipelineStagesMock.mockReset();
    mocks.useTaskAssigneesMock.mockReset();
    mocks.apiMock.mockReset();

    mocks.usePipelineStagesMock.mockReturnValue({
      loading: false,
      error: null,
      stages: [
        { id: "stage-opportunity", name: "Opportunity", slug: "opportunity", displayOrder: 1, isTerminal: false },
        { id: "stage-won", name: "Won", slug: "won", displayOrder: 6, isTerminal: true },
      ],
    });
    mocks.useTaskAssigneesMock.mockReturnValue({ assignees: [{ id: "rep-1", displayName: "Brett Jones" }] });
    mocks.useDealsMock.mockReturnValue(settledDeals());
    mocks.apiMock.mockResolvedValue({ deals: [makeDeal()], pagination: { totalPages: 1 } });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("re-keys the deals query AT MOST ONCE after the debounce window, not once per keystroke", () => {
    vi.useFakeTimers();
    const { container, unmount } = mountSection();
    try {
      const input = searchInput(container);

      // Three quick keystrokes -> the field updates locally each time, but the
      // server-keyed query value must NOT change yet.
      act(() => setNativeInputValue(input, "a"));
      act(() => setNativeInputValue(input, "ac"));
      act(() => setNativeInputValue(input, "acm"));

      expect(searchValuesSentToHook()).toEqual([]); // nothing committed mid-type

      act(() => vi.advanceTimersByTime(300));

      const committed = searchValuesSentToHook();
      expect(committed).toEqual(["acm"]); // exactly one commit, the final value
      expect(committed).not.toContain("a");
      expect(committed).not.toContain("ac");
    } finally {
      unmount();
    }
  });

  it("keeps the previously-loaded rows mounted during a refetch (no blank/flash)", () => {
    mocks.useDealsMock.mockReturnValue(settledDeals());
    const { container, rerender, unmount } = mountSection();
    try {
      expect(container.textContent).toContain("Palm Villas");

      // Simulate the in-flight refetch a keystroke triggers: still loading, prior rows present.
      mocks.useDealsMock.mockReturnValue(refetchingDeals());
      rerender();

      expect(container.textContent).toContain("Palm Villas");
      expect(container.textContent).not.toContain("Loading deals...");
    } finally {
      unmount();
    }
  });

  it("does not navigate or change the URL while typing in the search box", () => {
    vi.useFakeTimers();
    const { container, unmount } = mountSection("/deals?filter=won");
    try {
      const before = capturedLocation;
      expect(before).toBe("/deals?filter=won");

      const input = searchInput(container);
      act(() => setNativeInputValue(input, "a"));
      act(() => setNativeInputValue(input, "ac"));
      act(() => setNativeInputValue(input, "acm"));
      act(() => vi.advanceTimersByTime(300));

      expect(capturedLocation).toBe(before); // search stays in local state, never the URL
    } finally {
      unmount();
    }
  });

  // Regression guard (Codex P2): a list that mounts while its query is disabled (stages
  // still loading, no stage selected) must still show the skeleton through the FIRST real
  // fetch — the empty []-seeded idle result must not be treated as "settled".
  it("keeps the skeleton through the first real fetch even when the query started disabled", () => {
    // Phase 1: stages loading -> listQueryState.enabled = false, useDeals idle ([], not loading).
    mocks.usePipelineStagesMock.mockReturnValue({ loading: true, error: null, stages: [] });
    mocks.useDealsMock.mockReturnValue({
      deals: [], pagination: { page: 1, limit: 25, total: 0, totalPages: 0 }, loading: false, error: null, refetch: vi.fn(),
    });
    const { container, rerender, unmount } = mountSection();
    try {
      expect(container.textContent).toContain("Loading deals...");

      // Phase 2: stages loaded -> query enabled, FIRST real fetch in flight (loading, still empty).
      mocks.usePipelineStagesMock.mockReturnValue({
        loading: false, error: null,
        stages: [{ id: "stage-opportunity", name: "Opportunity", slug: "opportunity", displayOrder: 1, isTerminal: false }],
      });
      mocks.useDealsMock.mockReturnValue({
        deals: [], pagination: { page: 1, limit: 25, total: 0, totalPages: 0 }, loading: true, error: null, refetch: vi.fn(),
      });
      rerender();

      // The first fetch must show the skeleton, NOT an empty table.
      expect(container.textContent).toContain("Loading deals...");
    } finally {
      unmount();
    }
  });

  // Regression guard (Codex P2): a one-shot action (CSV export) must use the freshly typed
  // term, not a value still sitting in the debounce window. SearchInput flushes on blur, so
  // leaving the field (which a click on Export does) commits the term before the export runs.
  it("exports with the freshly typed search term even before the debounce fires", async () => {
    const createObjectURL = URL.createObjectURL;
    const revokeObjectURL = URL.revokeObjectURL;
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:test"), revokeObjectURL: vi.fn() });
    mocks.apiMock.mockResolvedValue({ deals: [], pagination: { totalPages: 1 } });
    const { container, unmount } = mountSection("/deals", { enableExport: true });
    try {
      const input = searchInput(container);
      act(() => setNativeInputValue(input, "acme")); // typed; debounce NOT advanced
      // focusout is what React delegates onBlur to; a real Export click blurs the input the same way.
      act(() => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }))); // focus leaves -> flush

      const exportButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Export"));
      expect(exportButton).toBeTruthy();
      await act(async () => {
        exportButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      const requestUrl = String(mocks.apiMock.mock.calls[0]?.[0] ?? "");
      expect(requestUrl).toContain("search=acme");
    } finally {
      Object.assign(URL, { createObjectURL, revokeObjectURL });
      unmount();
    }
  });
});
