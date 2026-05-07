import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { ContactListPage } from "./contact-list-page";

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
});
