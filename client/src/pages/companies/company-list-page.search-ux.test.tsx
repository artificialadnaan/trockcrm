// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";

import { CompanyListPage } from "./company-list-page";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  useCompaniesMock: vi.fn(),
  assignCompanyOwnerToMeMock: vi.fn(),
  reassignCompanyOwnerMock: vi.fn(),
  useAuthMock: vi.fn(),
  useTaskAssigneesMock: vi.fn(),
  useOwnerAssigneesMock: vi.fn(),
}));

vi.mock("@/hooks/use-companies", () => ({
  useCompanies: mocks.useCompaniesMock,
  assignCompanyOwnerToMe: mocks.assignCompanyOwnerToMeMock,
  reassignCompanyOwner: mocks.reassignCompanyOwnerMock,
}));
vi.mock("@/hooks/use-task-assignees", () => ({ useTaskAssignees: mocks.useTaskAssigneesMock }));
vi.mock("@/hooks/use-owner-assignees", () => ({ useOwnerAssignees: mocks.useOwnerAssigneesMock }));
vi.mock("@/lib/auth", () => ({ useAuth: mocks.useAuthMock }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const SEARCH_PLACEHOLDER = "Search accounts, cities, domains...";

function makeCompany(overrides: Record<string, unknown> = {}) {
  return {
    id: "company-1",
    name: "T Rock Owner Group",
    category: "client",
    address: "100 Main",
    city: "Dallas",
    state: "TX",
    website: "https://owner.example.com",
    ownerUserId: "user-1",
    ownerUserName: "Alicia Adams",
    industry: "property_owner",
    domain: "owner.example.com",
    lastActivityAt: "2026-04-11T09:00:00.000Z",
    contactCount: 4,
    dealCount: 2,
    contactsCount: 4,
    propertiesCount: 3,
    activeDealsCount: 2,
    pipelineValue: "750000",
    createdAt: "2026-04-10T10:00:00.000Z",
    updatedAt: "2026-04-11T10:00:00.000Z",
    ...overrides,
  };
}

function settledCompanies(companies = [makeCompany()]) {
  return {
    companies,
    pagination: { page: 1, limit: 50, total: companies.length, totalPages: 1 },
    loading: false,
    error: null,
    refetch: vi.fn(),
  };
}
function refetchingCompanies(companies = [makeCompany()]) {
  return {
    companies,
    pagination: { page: 1, limit: 50, total: companies.length, totalPages: 1 },
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

function mountPage(initialEntry = "/companies") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  const tree = () => (
    <MemoryRouter initialEntries={[initialEntry]}>
      <LocationProbe />
      <CompanyListPage />
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
  return mocks.useCompaniesMock.mock.calls
    .map((call) => (call[0] as { search?: string } | undefined)?.search ?? "")
    .filter((value) => value.length > 0);
}

describe("CompanyListPage — debounced, no-blank search UX (hard frontend requirement)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    mocks.useCompaniesMock.mockReset();
    mocks.assignCompanyOwnerToMeMock.mockReset();
    mocks.reassignCompanyOwnerMock.mockReset();
    mocks.useAuthMock.mockReset();
    mocks.useTaskAssigneesMock.mockReset();
    mocks.useOwnerAssigneesMock.mockReset();
    mocks.useAuthMock.mockReturnValue({
      user: { id: "rep-1", displayName: "Riley Rep", email: "rep@example.com", role: "rep", officeId: "office-1" },
      loading: false,
    });
    mocks.useTaskAssigneesMock.mockReturnValue({ assignees: [], loading: false, error: null });
    mocks.useOwnerAssigneesMock.mockReturnValue({ assignees: [], loading: false, error: null });
    mocks.useCompaniesMock.mockReturnValue(settledCompanies());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("re-keys the companies query AT MOST ONCE after the debounce window, not once per keystroke", () => {
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

  it("keeps the previously-loaded accounts mounted during a refetch (no blank/flash)", () => {
    mocks.useCompaniesMock.mockReturnValue(settledCompanies());
    const { container, rerender, unmount } = mountPage();
    try {
      expect(container.textContent).toContain("T Rock Owner Group");

      // In-flight refetch a search triggers: still loading, prior rows present.
      mocks.useCompaniesMock.mockReturnValue(refetchingCompanies());
      rerender();

      expect(container.textContent).toContain("T Rock Owner Group");
      expect(container.textContent).toContain("Updating..."); // refresh hint, not a skeleton swap
    } finally {
      unmount();
    }
  });

  it("does not navigate or change the URL while typing (search stays local state)", () => {
    vi.useFakeTimers();
    const { container, unmount } = mountPage("/companies");
    try {
      expect(capturedLocation).toBe("/companies");

      const input = searchInput(container);
      act(() => setNativeInputValue(input, "a"));
      act(() => setNativeInputValue(input, "ac"));
      act(() => setNativeInputValue(input, "acm"));
      act(() => vi.advanceTimersByTime(300));

      expect(capturedLocation).toBe("/companies"); // never mirrored to the URL — no nav/reload
    } finally {
      unmount();
    }
  });
});
