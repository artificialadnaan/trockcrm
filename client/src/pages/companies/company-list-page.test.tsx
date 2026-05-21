// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { CompanyListPage } from "./company-list-page";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

async function renderPageDom() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <MemoryRouter>
        <CompanyListPage />
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

  it("renders visible pagination buttons with a distinct disabled state", async () => {
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
      pagination: { page: 1, limit: 50, total: 51, totalPages: 2 },
      loading: false,
      error: null,
    });
    const { container, cleanup } = await renderPageDom();
    try {
      const previousButton = container.querySelector('[aria-label="Previous companies page"]');
      const nextButton = container.querySelector('[aria-label="Next companies page"]');

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
      expect(container.querySelector('[aria-label="Previous companies page"]')).toBeNull();
      expect(container.querySelector('[aria-label="Next companies page"]')).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("keeps the next button visibly disabled on the last page", async () => {
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
      pagination: { page: 2, limit: 50, total: 51, totalPages: 2 },
      loading: false,
      error: null,
    });
    const { container, cleanup } = await renderPageDom();
    try {
      const nextButton = container.querySelector<HTMLButtonElement>('[aria-label="Next companies page"]');
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
