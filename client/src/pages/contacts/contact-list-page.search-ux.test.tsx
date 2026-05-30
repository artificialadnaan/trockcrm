// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";

import { ContactListPage } from "./contact-list-page";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  useContactsMock: vi.fn(),
  assignContactOwnerToMeMock: vi.fn(),
  reassignContactOwnerMock: vi.fn(),
  useAuthMock: vi.fn(),
  useTaskAssigneesMock: vi.fn(),
  useOwnerAssigneesMock: vi.fn(),
}));

// NOTE: use-contact-filters is intentionally NOT mocked — the real (localStorage-backed) filter
// state is what carries the debounced search down to useContacts, which is the unit under test.
vi.mock("@/hooks/use-contacts", () => ({
  useContacts: mocks.useContactsMock,
  assignContactOwnerToMe: mocks.assignContactOwnerToMeMock,
  reassignContactOwner: mocks.reassignContactOwnerMock,
}));
vi.mock("@/hooks/use-task-assignees", () => ({ useTaskAssignees: mocks.useTaskAssigneesMock }));
vi.mock("@/hooks/use-owner-assignees", () => ({ useOwnerAssignees: mocks.useOwnerAssigneesMock }));
vi.mock("@/lib/auth", () => ({ useAuth: mocks.useAuthMock }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const SEARCH_PLACEHOLDER = "Search contacts, companies, email...";

function makeContact(overrides: Record<string, unknown> = {}) {
  return {
    id: "contact-1",
    firstName: "Zephyr",
    lastName: "Quartz",
    email: "zephyr@example.com",
    companyName: "Quartzite Holdings",
    jobTitle: "Facilities director",
    category: "client",
    role: "decision_maker",
    ownerUserId: "user-1",
    ownerUserName: "Alicia Adams",
    isPrimary: true,
    isActive: true,
    linkedDealsCount: 2,
    lastTouchAt: "2026-04-11T09:00:00.000Z",
    createdAt: "2026-04-10T10:00:00.000Z",
    updatedAt: "2026-04-11T10:00:00.000Z",
    ...overrides,
  };
}

function settledContacts(contacts = [makeContact()]) {
  return {
    contacts,
    pagination: { page: 1, limit: 50, total: contacts.length, totalPages: 1 },
    loading: false,
    error: null,
    refetch: vi.fn(),
  };
}
function refetchingContacts(contacts = [makeContact()]) {
  return {
    contacts,
    pagination: { page: 1, limit: 50, total: contacts.length, totalPages: 1 },
    loading: true,
    error: null,
    refetch: vi.fn(),
  };
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

function mountPage(initialEntry = "/contacts") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  const tree = () => (
    <MemoryRouter initialEntries={[initialEntry]}>
      <LocationProbe />
      <ContactListPage />
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

function searchValuesSentToHook() {
  return mocks.useContactsMock.mock.calls
    .map((call) => (call[0] as { search?: string } | undefined)?.search ?? "")
    .filter((value) => value.length > 0);
}

describe("ContactListPage — debounced, no-blank search UX (hard frontend requirement)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear(); // real useContactFilters reads defaults from localStorage
    mocks.useContactsMock.mockReset();
    mocks.assignContactOwnerToMeMock.mockReset();
    mocks.reassignContactOwnerMock.mockReset();
    mocks.useAuthMock.mockReset();
    mocks.useTaskAssigneesMock.mockReset();
    mocks.useOwnerAssigneesMock.mockReset();
    mocks.useAuthMock.mockReturnValue({
      user: { id: "user-1", displayName: "Riley Rep", email: "rep@example.com", role: "rep", officeId: "office-1" },
      loading: false,
    });
    mocks.useTaskAssigneesMock.mockReturnValue({ assignees: [], loading: false, error: null });
    mocks.useOwnerAssigneesMock.mockReturnValue({ assignees: [], loading: false, error: null });
    mocks.useContactsMock.mockReturnValue(settledContacts());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("re-keys the contacts query AT MOST ONCE after the debounce window, not once per keystroke", () => {
    vi.useFakeTimers();
    const { container, unmount } = mountPage();
    try {
      const input = searchInput(container);

      act(() => setNativeInputValue(input, "a"));
      act(() => setNativeInputValue(input, "ac"));
      act(() => setNativeInputValue(input, "acm"));

      expect(searchValuesSentToHook()).toEqual([]); // nothing committed mid-type

      act(() => vi.advanceTimersByTime(300));

      expect([...new Set(searchValuesSentToHook())]).toEqual(["acm"]); // one committed value, the final term
    } finally {
      unmount();
    }
  });

  it("keeps the previously-loaded contacts mounted during a refetch (no blank/flash)", () => {
    mocks.useContactsMock.mockReturnValue(settledContacts());
    const { container, rerender, unmount } = mountPage();
    try {
      expect(container.textContent).toContain("Zephyr Quartz");

      mocks.useContactsMock.mockReturnValue(refetchingContacts());
      rerender();

      expect(container.textContent).toContain("Zephyr Quartz");
      expect(container.textContent).toContain("Updating..."); // refresh hint, not a skeleton swap
    } finally {
      unmount();
    }
  });

  it("does not navigate or change the URL while typing (search stays local/persisted state)", () => {
    vi.useFakeTimers();
    const { container, unmount } = mountPage("/contacts");
    try {
      expect(capturedLocation).toBe("/contacts");

      const input = searchInput(container);
      act(() => setNativeInputValue(input, "a"));
      act(() => setNativeInputValue(input, "ac"));
      act(() => setNativeInputValue(input, "acm"));
      act(() => vi.advanceTimersByTime(300));

      expect(capturedLocation).toBe("/contacts"); // never mirrored to the URL — no nav/reload
    } finally {
      unmount();
    }
  });
});
