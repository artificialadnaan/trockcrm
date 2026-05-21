// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { ContactListPage } from "./contact-list-page";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  useContactsMock: vi.fn(),
  setFiltersMock: vi.fn(),
  resetFiltersMock: vi.fn(),
}));

vi.mock("@/hooks/use-contacts", () => ({
  useContacts: mocks.useContactsMock,
}));

vi.mock("@/hooks/use-contact-filters", () => ({
  useContactFilters: () => ({
    filters: { isActive: true, sortBy: "updated_at", sortDir: "desc", page: 1, limit: 50 },
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

describe("ContactListPage", () => {
  beforeEach(() => {
    mocks.useContactsMock.mockReset();
    mocks.setFiltersMock.mockReset();
    mocks.resetFiltersMock.mockReset();
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
    });
  });

  it("renders A1 contact role, primary state, linked deals, and last touch", () => {
    const html = normalize(renderPage());

    expect(mocks.useContactsMock).toHaveBeenCalledWith({
      isActive: true,
      sortBy: "updated_at",
      sortDir: "desc",
      page: 1,
      limit: 50,
    });
    expect(html).toContain("Maria Caldwell");
    expect(html).toContain("Facilities director");
    expect(html).toContain("T Rock Owner Group");
    expect(html).toContain("Primary contacts");
    expect(html).toContain("Apr 11, 2026");
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
    } finally {
      await cleanup();
    }
  });
});
