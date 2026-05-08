import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { CompanyListPage } from "./company-list-page";

const mocks = vi.hoisted(() => ({
  useCompaniesMock: vi.fn(),
}));

vi.mock("@/hooks/use-companies", () => ({
  useCompanies: mocks.useCompaniesMock,
}));

function normalize(html: string) {
  return html.replace(/\s+/g, " ").trim();
}

function renderPage() {
  return renderToStaticMarkup(
    <MemoryRouter>
      <CompanyListPage />
    </MemoryRouter>
  );
}

describe("CompanyListPage", () => {
  beforeEach(() => {
    mocks.useCompaniesMock.mockReset();
    mocks.useCompaniesMock.mockReturnValue({
      companies: [
        {
          id: "company-1",
          name: "T Rock Owner Group",
          category: "client",
          address: "100 Main",
          city: "Dallas",
          state: "TX",
          zip: "75201",
          phone: null,
          website: "https://owner.example.com",
          industry: "property_owner",
          region: "DFW",
          domain: "owner.example.com",
          lastActivityAt: "2026-04-11T09:00:00.000Z",
          hubspotId: "hs-1",
          procoreId: "pc-1",
          notes: null,
          companyVerificationStatus: null,
          companyVerificationRequestedAt: null,
          companyVerificationEmailSentAt: null,
          companyVerifiedAt: null,
          companyVerifiedBy: null,
          contactCount: 4,
          dealCount: 2,
          contactsCount: 4,
          propertiesCount: 3,
          activeDealsCount: 2,
          pipelineValue: "750000",
          createdAt: "2026-04-10T10:00:00.000Z",
          updatedAt: "2026-04-11T10:00:00.000Z",
        },
      ],
      pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
      loading: false,
      error: null,
    });
  });

  it("renders A1 company columns and construction-specific industry labels", () => {
    const html = normalize(renderPage());

    expect(mocks.useCompaniesMock).toHaveBeenCalledWith({
      search: undefined,
      industry: undefined,
      page: 1,
      limit: 50,
    });
    expect(html).toContain("T Rock Owner Group");
    expect(html).toContain("Property owner");
    expect(html).toContain("owner.example.com");
    expect(html).toContain("$750,000");
  });
});
