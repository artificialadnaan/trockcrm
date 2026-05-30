// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import type { ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";

import { LeadListPage } from "./lead-list-page";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  useLeadBoardMock: vi.fn(),
  useLeadsMock: vi.fn(),
  useAuthMock: vi.fn(),
  useTaskAssigneesMock: vi.fn(),
}));

// Keep the real LEAD_BOARD_STAGE_SLUGS / getLeadBoardStageLabel / types; only the two data
// hooks are stubbed so the test can drive board state + spy on the search value sent down.
vi.mock("@/hooks/use-leads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-leads")>()),
  useLeadBoard: mocks.useLeadBoardMock,
  useLeads: mocks.useLeadsMock,
}));
vi.mock("@/lib/auth", () => ({ useAuth: mocks.useAuthMock }));
vi.mock("@/hooks/use-task-assignees", () => ({ useTaskAssignees: mocks.useTaskAssigneesMock }));

// Plain input so typing via the native value setter behaves predictably; the real SearchInput
// (with its useDebouncedValue) is exercised unmocked — that is the unit under test.
vi.mock("@/components/ui/input", () => ({
  Input: (props: Record<string, unknown>) => <input {...props} />,
}));
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectValue: ({ children, placeholder }: { children?: ReactNode; placeholder?: string }) => (
    <span>{children ?? placeholder ?? ""}</span>
  ),
}));

const SEARCH_PLACEHOLDER = "Search leads";

function makeCard(overrides: Record<string, unknown> = {}) {
  return {
    id: "lead-1",
    name: "Acme Roof Lead",
    companyName: "Acme Construction",
    source: "referral",
    propertyCity: "Dallas",
    propertyState: "TX",
    primaryContactId: null,
    assignedRepName: "Brett Jones",
    stageEnteredAt: "2026-04-10T10:00:00.000Z",
    description: null,
    ...overrides,
  };
}

function board(cards = [makeCard()]) {
  return { columns: [{ stage: { id: "stage-new", slug: "new_lead", name: "New" }, count: cards.length, cards }] };
}

function settledBoard() {
  return { board: board(), loading: false, error: null, convertLead: vi.fn(), refetch: vi.fn() };
}
function refetchingBoard() {
  return { board: board(), loading: true, error: null, convertLead: vi.fn(), refetch: vi.fn() };
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

function mountPage(initialEntry = "/leads") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  const tree = () => (
    <MemoryRouter initialEntries={[initialEntry]}>
      <LocationProbe />
      <LeadListPage />
    </MemoryRouter>
  );
  act(() => {
    root = createRoot(container);
    root.render(tree());
  });
  return {
    container,
    rerender: () => act(() => root.render(tree())),
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

// useLeadBoard(scope, assignedRepId, search) -> the search term is the 3rd positional arg.
function searchValuesSentToBoard() {
  return mocks.useLeadBoardMock.mock.calls
    .map((call) => (call[2] as string | undefined) ?? "")
    .filter((value) => value.length > 0);
}

describe("LeadListPage — debounced, no-blank search UX (hard frontend requirement)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    mocks.useLeadBoardMock.mockReset();
    mocks.useLeadsMock.mockReset();
    mocks.useAuthMock.mockReset();
    mocks.useTaskAssigneesMock.mockReset();
    mocks.useAuthMock.mockReturnValue({ user: { id: "user-1", role: "rep" }, loading: false });
    mocks.useTaskAssigneesMock.mockReturnValue({ assignees: [] });
    mocks.useLeadsMock.mockReturnValue({ leads: [], loading: false, error: null, refetch: vi.fn() });
    mocks.useLeadBoardMock.mockReturnValue(settledBoard());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("re-keys the board query AT MOST ONCE after the debounce window, not once per keystroke", () => {
    vi.useFakeTimers();
    const { container, unmount } = mountPage();
    try {
      const input = searchInput(container);

      // Three quick keystrokes -> the field updates locally, but the server-keyed board
      // query value must NOT change yet.
      act(() => setNativeInputValue(input, "a"));
      act(() => setNativeInputValue(input, "ac"));
      act(() => setNativeInputValue(input, "acm"));

      expect(searchValuesSentToBoard()).toEqual([]); // nothing committed mid-type

      act(() => vi.advanceTimersByTime(300));

      // Exactly one committed value — the final term — never the intermediate keystrokes.
      expect([...new Set(searchValuesSentToBoard())]).toEqual(["acm"]);
    } finally {
      unmount();
    }
  });

  it("keeps the previously-loaded board mounted during a refetch (no blank/flash)", () => {
    mocks.useLeadBoardMock.mockReturnValue(settledBoard());
    const { container, rerender, unmount } = mountPage();
    try {
      expect(container.textContent).toContain("Acme Roof Lead");

      // Simulate the in-flight refetch a search triggers: still loading, prior board present.
      mocks.useLeadBoardMock.mockReturnValue(refetchingBoard());
      rerender();

      expect(container.textContent).toContain("Acme Roof Lead");
      expect(container.textContent).not.toContain("Loading lead board...");
    } finally {
      unmount();
    }
  });

  it("does not navigate per keystroke; commits the search to the URL once after the debounce", () => {
    vi.useFakeTimers();
    const { container, unmount } = mountPage("/leads");
    try {
      expect(capturedLocation).toBe("/leads");

      const input = searchInput(container);
      act(() => setNativeInputValue(input, "a"));
      act(() => setNativeInputValue(input, "ac"));
      act(() => setNativeInputValue(input, "acm"));

      expect(capturedLocation).toBe("/leads"); // no per-keystroke navigation

      act(() => vi.advanceTimersByTime(300));

      expect(capturedLocation).toBe("/leads?search=acm"); // a single debounced (replace) commit
    } finally {
      unmount();
    }
  });
});
