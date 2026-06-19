// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { getOwnerInitialColor } from "@trock-crm/shared/types";
import { ContactListPage } from "./contact-list-page";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  useContactsMock: vi.fn(),
  assignContactOwnerToMeMock: vi.fn(),
  reassignContactOwnerMock: vi.fn(),
  setFiltersMock: vi.fn(),
  resetFiltersMock: vi.fn(),
  useAuthMock: vi.fn(),
  useTaskAssigneesMock: vi.fn(),
  useOwnerAssigneesMock: vi.fn(),
  useContactFiltersOverride: undefined as undefined | { sortBy?: string; sortDir?: "asc" | "desc" },
}));

vi.mock("@/hooks/use-contacts", () => ({
  useContacts: mocks.useContactsMock,
  assignContactOwnerToMe: mocks.assignContactOwnerToMeMock,
  reassignContactOwner: mocks.reassignContactOwnerMock,
}));

vi.mock("@/hooks/use-task-assignees", () => ({
  useTaskAssignees: mocks.useTaskAssigneesMock,
}));

vi.mock("@/hooks/use-owner-assignees", () => ({
  useOwnerAssignees: mocks.useOwnerAssigneesMock,
}));

vi.mock("@/lib/auth", () => ({
  useAuth: mocks.useAuthMock,
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/hooks/use-contact-filters", () => ({
  useContactFilters: () => ({
    filters: {
      isActive: true,
      sortBy: "updated_at",
      sortDir: "desc",
      page: 1,
      limit: 50,
      ...(mocks.useContactFiltersOverride ?? {}),
    },
    setFilters: mocks.setFiltersMock,
    resetFilters: mocks.resetFiltersMock,
  }),
}));

function normalize(html: string) {
  return html.replace(/\s+/g, " ").trim();
}

function renderPage() {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ContactListPage />
    </MemoryRouter>
  );
}

async function renderPageDom() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <MemoryRouter>
        <ContactListPage />
      </MemoryRouter>
    );
  });
  return {
    container,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function renderDomAt(path: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <ContactListPage />
      </MemoryRouter>
    );
  });
  return {
    container,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe("ContactListPage", () => {
  beforeEach(() => {
    mocks.useContactsMock.mockReset();
    mocks.assignContactOwnerToMeMock.mockReset();
    mocks.reassignContactOwnerMock.mockReset();
    mocks.setFiltersMock.mockReset();
    mocks.resetFiltersMock.mockReset();
    mocks.useAuthMock.mockReset();
    mocks.useTaskAssigneesMock.mockReset();
    mocks.useOwnerAssigneesMock.mockReset();
    mocks.useAuthMock.mockReturnValue({
      user: {
        id: "rep-1",
        displayName: "Riley Rep",
        email: "rep@example.com",
        role: "rep",
        officeId: "office-1",
      },
      loading: false,
    });
    mocks.useTaskAssigneesMock.mockReturnValue({
      assignees: [
        { id: "rep-1", displayName: "Riley Rep" },
        { id: "director-1", displayName: "Dana Director" },
      ],
      loading: false,
      error: null,
    });
    mocks.useOwnerAssigneesMock.mockReturnValue({
      assignees: [
        { id: "rep-1", displayName: "Riley Rep" },
        { id: "director-1", displayName: "Dana Director" },
      ],
      loading: false,
      error: null,
    });
    mocks.assignContactOwnerToMeMock.mockResolvedValue({ contact: { id: "contact-2", ownerId: "rep-1" } });
    mocks.reassignContactOwnerMock.mockResolvedValue({ contact: { id: "contact-1", ownerId: "director-1" } });
    mocks.useContactsMock.mockReturnValue({
      contacts: [
        {
          id: "contact-1",
          firstName: "Maria",
          lastName: "Caldwell",
          email: "maria@example.com",
          phone: "2145550101",
          mobile: null,
          companyName: "T Rock Owner Group",
          companyId: "company-1",
          ownerUserId: "user-1",
          ownerUserName: "Alicia Adams",
          jobTitle: "Facilities Director",
          category: "client",
          role: "facilities_director",
          isPrimary: true,
          linkedinUrl: null,
          address: null,
          city: "Dallas",
          state: "TX",
          zip: null,
          notes: null,
          touchpointCount: 3,
          lastContactedAt: "2026-04-11T09:00:00.000Z",
          firstOutreachCompleted: true,
          procoreContactId: null,
          hubspotContactId: "hs-contact-1",
          linkedDealsCount: 2,
          lastTouchAt: "2026-04-11T09:00:00.000Z",
          normalizedPhone: null,
          isActive: true,
          createdAt: "2026-04-10T10:00:00.000Z",
          updatedAt: "2026-04-11T10:00:00.000Z",
        },
      ],
      pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
  });

  it("?card=primary wires the isPrimary drill into the query and shows a clearable chip", async () => {
    mocks.useContactsMock.mockReturnValue({
      contacts: [],
      pagination: { page: 1, limit: 50, total: 7, totalPages: 1, primaryCount: 7, untouchedCount: 3 },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    const { container, cleanup } = await renderDomAt("/contacts?card=primary");
    try {
      // The drill param reaches the data hook, so the server filters to primary contacts.
      const allCalls = mocks.useContactsMock.mock.calls;
      const lastCall = allCalls[allCalls.length - 1]?.[0];
      expect(lastCall?.isPrimary).toBe(true);
      expect(lastCall?.untouched).toBeUndefined();
      // Active-filter chip names the drilled card and is clearable.
      expect(container.textContent).toContain("Filtered: Primary contacts");
      expect(container.querySelector('button[aria-label="Clear card filter"]')).not.toBeNull();
      // Exactly the drilled card carries the active ring (bare "ring-brand-red" token, not the
      // "focus-visible:ring-brand-red" every clickable card has).
      expect(container.querySelectorAll(".ring-brand-red").length).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("?card=untouched wires the untouched drill (not isPrimary) into the query", async () => {
    mocks.useContactsMock.mockReturnValue({
      contacts: [],
      pagination: { page: 1, limit: 50, total: 3, totalPages: 1, primaryCount: 7, untouchedCount: 3 },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    const { container, cleanup } = await renderDomAt("/contacts?card=untouched");
    try {
      const allCalls = mocks.useContactsMock.mock.calls;
      const lastCall = allCalls[allCalls.length - 1]?.[0];
      expect(lastCall?.untouched).toBe(true);
      expect(lastCall?.isPrimary).toBeUndefined();
      expect(container.textContent).toContain("Filtered: Untouched 30d+");
    } finally {
      await cleanup();
    }
  });

  it("renders A1 contact role, primary state, linked deals, and last touch", () => {
    const html = normalize(renderPage());
    const ownerColor = getOwnerInitialColor("user-1");

    expect(mocks.useContactsMock).toHaveBeenCalledWith({
      isActive: true,
      sortBy: "updated_at",
      sortDir: "desc",
      page: 1,
      limit: 50,
    });
    expect(html).toContain("Maria Caldwell");
    expect(html).toContain("Alicia Adams");
    expect(html).toContain("AA");
    expect(html).toContain(`background-color:${ownerColor.backgroundColor}`);
    expect(html).toContain(`color:${ownerColor.textColor}`);
    expect(html).toContain("Facilities director");
    expect(html).toContain("T Rock Owner Group");
    expect(html).toContain("Primary contacts");
    expect(html).toContain("Apr 11, 2026");
  });

  it("shows Unassigned when a contact has no owner", () => {
    mocks.useContactsMock.mockReturnValue({
      contacts: [
        {
          id: "contact-2",
          firstName: "No",
          lastName: "Owner",
          email: null,
          phone: null,
          mobile: null,
          companyName: "T Rock Owner Group",
          companyId: "company-1",
          ownerUserId: null,
          ownerUserName: null,
          jobTitle: null,
          category: "client",
          role: null,
          isPrimary: false,
          linkedinUrl: null,
          address: null,
          city: null,
          state: null,
          zip: null,
          notes: null,
          touchpointCount: 0,
          lastContactedAt: null,
          firstOutreachCompleted: false,
          procoreContactId: null,
          hubspotContactId: null,
          linkedDealsCount: 0,
          lastTouchAt: null,
          normalizedPhone: null,
          isActive: true,
          createdAt: "2026-04-10T10:00:00.000Z",
          updatedAt: "2026-04-11T10:00:00.000Z",
        },
      ],
      pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
      loading: false,
      error: null,
    });

    expect(normalize(renderPage())).toContain("Unassigned");
  });

  it("shows assign to me for an unassigned contact and refreshes after claiming it", async () => {
    const refetch = vi.fn();
    mocks.useContactsMock.mockReturnValue({
      contacts: [
        {
          id: "contact-2",
          firstName: "No",
          lastName: "Owner",
          email: null,
          phone: null,
          mobile: null,
          companyName: "T Rock Owner Group",
          companyId: "company-1",
          ownerUserId: null,
          ownerUserName: null,
          jobTitle: null,
          category: "client",
          role: null,
          isPrimary: false,
          linkedinUrl: null,
          address: null,
          city: null,
          state: null,
          zip: null,
          notes: null,
          touchpointCount: 0,
          lastContactedAt: null,
          firstOutreachCompleted: false,
          procoreContactId: null,
          hubspotContactId: null,
          linkedDealsCount: 0,
          lastTouchAt: null,
          normalizedPhone: null,
          isActive: true,
          createdAt: "2026-04-10T10:00:00.000Z",
          updatedAt: "2026-04-11T10:00:00.000Z",
        },
      ],
      pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
      loading: false,
      error: null,
      refetch,
    });

    const { container, cleanup } = await renderPageDom();
    try {
      const assignButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Assign to me"
      );
      expect(assignButton).toBeTruthy();

      await act(async () => {
        assignButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(mocks.assignContactOwnerToMeMock).toHaveBeenCalledWith("contact-2");
      expect(refetch).toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it("does not show assign to me on an already-owned contact for a rep", () => {
    expect(normalize(renderPage())).not.toContain("Assign to me");
  });

  it("shows a reassign owner affordance for admins", () => {
    mocks.useAuthMock.mockReturnValue({
      user: {
        id: "admin-1",
        displayName: "Ada Admin",
        email: "admin@example.com",
        role: "admin",
        officeId: "office-1",
      },
      loading: false,
    });

    expect(normalize(renderPage())).toContain("Reassign owner");
  });

  it("filters contacts between All and Mine ownership scopes", async () => {
    const { container, cleanup } = await renderPageDom();
    try {
      const ownershipFilter = container.querySelector('[aria-label="Ownership filter"]');
      const buttons = [...(ownershipFilter?.querySelectorAll("button") ?? [])];
      const mineButton = buttons.find((button) => button.textContent?.trim() === "Mine");
      const allButton = buttons.find((button) => button.textContent?.trim() === "All");

      expect(ownershipFilter).not.toBeNull();
      expect(mineButton).not.toBeUndefined();
      expect(allButton).not.toBeUndefined();
      expect(allButton?.getAttribute("aria-pressed")).toBe("true");

      await act(async () => {
        mineButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(mocks.setFiltersMock).toHaveBeenCalledWith({ ownerScope: "mine" });
    } finally {
      await cleanup();
    }
  });

  it("renders visible pagination buttons with a distinct disabled state", async () => {
    mocks.useContactsMock.mockReturnValue({
      contacts: [
        {
          id: "contact-1",
          firstName: "Maria",
          lastName: "Caldwell",
          email: "maria@example.com",
          phone: "2145550101",
          mobile: null,
          companyName: "T Rock Owner Group",
          companyId: "company-1",
          ownerUserId: "user-1",
          ownerUserName: "Alicia Adams",
          jobTitle: "Facilities Director",
          category: "client",
          role: "facilities_director",
          isPrimary: true,
          linkedinUrl: null,
          address: null,
          city: "Dallas",
          state: "TX",
          zip: null,
          notes: null,
          touchpointCount: 3,
          lastContactedAt: "2026-04-11T09:00:00.000Z",
          firstOutreachCompleted: true,
          procoreContactId: null,
          hubspotContactId: "hs-contact-1",
          linkedDealsCount: 2,
          lastTouchAt: "2026-04-11T09:00:00.000Z",
          normalizedPhone: null,
          isActive: true,
          createdAt: "2026-04-10T10:00:00.000Z",
          updatedAt: "2026-04-11T10:00:00.000Z",
        },
      ],
      pagination: { page: 1, limit: 50, total: 51, totalPages: 2 },
      loading: false,
      error: null,
    });
    const { container, cleanup } = await renderPageDom();
    try {
      const previousButton = container.querySelector('[aria-label="Previous contacts page"]');
      const nextButton = container.querySelector('[aria-label="Next contacts page"]');

      expect(previousButton).not.toBeNull();
      expect(nextButton).not.toBeNull();
      expect(previousButton?.className).toContain("bg-primary");
      expect(previousButton?.className).toContain("text-primary-foreground");
      expect(previousButton?.className).not.toContain("bg-background");
      expect(previousButton?.className).toContain("disabled:border-muted-foreground/20");
      expect(previousButton?.className).toContain("disabled:bg-muted");
      expect(previousButton?.className).toContain("disabled:text-muted-foreground");
      expect(nextButton?.className).toContain("bg-primary");
      expect(nextButton?.className).toContain("text-primary-foreground");
      expect(nextButton?.className).not.toContain("bg-background");
    } finally {
      await cleanup();
    }
  });

  it("does not render pagination controls for a single page", async () => {
    const { container, cleanup } = await renderPageDom();
    try {
      expect(container.querySelector('[aria-label="Previous contacts page"]')).toBeNull();
      expect(container.querySelector('[aria-label="Next contacts page"]')).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("keeps the next button visibly disabled on the last page", async () => {
    mocks.useContactsMock.mockReturnValue({
      contacts: [
        {
          id: "contact-1",
          firstName: "Maria",
          lastName: "Caldwell",
          email: "maria@example.com",
          phone: "2145550101",
          mobile: null,
          companyName: "T Rock Owner Group",
          companyId: "company-1",
          ownerUserId: "user-1",
          ownerUserName: "Alicia Adams",
          jobTitle: "Facilities Director",
          category: "client",
          role: "facilities_director",
          isPrimary: true,
          linkedinUrl: null,
          address: null,
          city: "Dallas",
          state: "TX",
          zip: null,
          notes: null,
          touchpointCount: 3,
          lastContactedAt: "2026-04-11T09:00:00.000Z",
          firstOutreachCompleted: true,
          procoreContactId: null,
          hubspotContactId: "hs-contact-1",
          linkedDealsCount: 2,
          lastTouchAt: "2026-04-11T09:00:00.000Z",
          normalizedPhone: null,
          isActive: true,
          createdAt: "2026-04-10T10:00:00.000Z",
          updatedAt: "2026-04-11T10:00:00.000Z",
        },
      ],
      pagination: { page: 2, limit: 50, total: 51, totalPages: 2 },
      loading: false,
      error: null,
    });
    const { container, cleanup } = await renderPageDom();
    try {
      const nextButton = container.querySelector<HTMLButtonElement>('[aria-label="Next contacts page"]');
      expect(nextButton?.disabled).toBe(true);
      expect(nextButton?.className).toContain("bg-primary");
      expect(nextButton?.className).toContain("text-primary-foreground");
      expect(nextButton?.className).not.toContain("bg-background");
      expect(nextButton?.className).toContain("disabled:border-muted-foreground/20");
      expect(nextButton?.className).toContain("disabled:bg-muted");
      expect(nextButton?.className).toContain("disabled:text-muted-foreground");
      // Touch sizing: 44px (size-11) on phones, reverting to the compact size-8 at md.
      expect(nextButton?.className).toContain("size-11");
      expect(nextButton?.className).toContain("md:size-8");
    } finally {
      await cleanup();
    }
  });

  it("stacks the table into a md:hidden card list with >=44px touch quick actions on phones", async () => {
    const { container, cleanup } = await renderPageDom();
    try {
      // Desktop keeps the full table, gated behind hidden md:block so phones get no scroll wall.
      const tableWrap = container.querySelector("div.hidden.md\\:block");
      expect(tableWrap?.querySelector("table")).toBeTruthy();
      // A md:hidden card list carries the same contacts on phones.
      const cards = container.querySelector('[data-testid="contact-cards"]');
      expect(cards).not.toBeNull();
      expect(cards?.className).toContain("md:hidden");
      expect(cards?.textContent).toContain("Maria Caldwell");
      // The card name is a real link to the contact (stretched-link pattern).
      expect(cards?.querySelector('a[href="/contacts/contact-1"]')).toBeTruthy();
      // Quick-action call link is a 44px touch target inside the card.
      const callLink = cards?.querySelector('a[href^="tel:"]');
      expect(callLink?.className).toContain("h-11");
      expect(callLink?.className).toContain("w-11");
      // The real action raises itself above the stretched card link (so it stays a
      // distinct tap), while non-interactive bits fall back to the card navigation.
      expect(callLink?.className).toContain("z-10");
      // Role filter pills opt into the 44px touch size (reverts at md).
      const roleFilter = container.querySelector('[aria-label="Contact role filter"]');
      expect(roleFilter?.querySelector("button")?.className).toContain("min-h-[44px]");
    } finally {
      await cleanup();
    }
  });

  describe("sortable headers (server-side sort over the full set)", () => {
    function headerButton(container: HTMLElement, label: string): HTMLButtonElement {
      const btn = Array.from(container.querySelectorAll("button")).find((b) =>
        (b.getAttribute("aria-label") ?? "").startsWith(`Sort by ${label}`)
      );
      if (!btn) throw new Error(`no sortable header "${label}"`);
      return btn as HTMLButtonElement;
    }

    it("clicking a header sends the mapped sortBy/sortDir to the API (default direction by type)", async () => {
      const { container, cleanup } = await renderPageDom();
      try {
        // text column → default asc; date column → default desc.
        await act(async () => {
          headerButton(container, "Contact").dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(mocks.setFiltersMock).toHaveBeenCalledWith({ sortBy: "name", sortDir: "asc" });

        await act(async () => {
          headerButton(container, "Last touch").dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(mocks.setFiltersMock).toHaveBeenCalledWith({ sortBy: "last_touch_at", sortDir: "desc" });

        await act(async () => {
          headerButton(container, "Company").dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(mocks.setFiltersMock).toHaveBeenCalledWith({ sortBy: "company_name", sortDir: "asc" });
      } finally {
        await cleanup();
      }
    });

    it("the active column reflects the persisted sort and toggles its direction on re-click", async () => {
      // Persisted filter already sorts by last_touch_at desc → that header is active; re-click flips to asc.
      mocks.useContactFiltersOverride = { sortBy: "last_touch_at", sortDir: "desc" };
      const { container, cleanup } = await renderPageDom();
      try {
        const lastTouch = headerButton(container, "Last touch");
        expect(lastTouch.getAttribute("aria-label")).toContain("sorted descending");
        await act(async () => {
          lastTouch.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(mocks.setFiltersMock).toHaveBeenCalledWith({ sortBy: "last_touch_at", sortDir: "asc" });
      } finally {
        mocks.useContactFiltersOverride = undefined;
        await cleanup();
      }
    });
  });
});
