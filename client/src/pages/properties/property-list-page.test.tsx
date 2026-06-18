// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { PropertyListPage } from "./property-list-page";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  usePropertiesMock: vi.fn(),
}));

vi.mock("@/hooks/use-properties", () => ({
  useProperties: mocks.usePropertiesMock,
  formatPropertyLabel: vi.fn((property: { address?: string | null; city?: string | null; state?: string | null; zip?: string | null; name?: string }) =>
    [property.address, [property.city, property.state].filter(Boolean).join(", "), property.zip].filter(Boolean).join(" ") || property.name || "Unassigned Property"
  ),
}));

function normalize(html: string) {
  return html.replace(/\s+/g, " ").trim();
}

function renderPage() {
  return renderToStaticMarkup(
    <MemoryRouter>
      <PropertyListPage />
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
        <PropertyListPage />
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

describe("PropertyListPage", () => {
  beforeEach(() => {
    mocks.usePropertiesMock.mockReset();
    mocks.usePropertiesMock.mockReturnValue({
      properties: [
        {
          id: "property-1",
          companyId: "company-1",
          companyName: "Alpha Roofing",
          name: "Dallas HQ",
          address: "123 Main St",
          city: "Dallas",
          state: "TX",
          zip: "75201",
          notes: null,
          type: "industrial",
          roofArea: 125000,
          linkedValue: "300000",
          activePipelineValue: "300000",
          engagementStatus: "won",
          photosCount: 2,
          isActive: true,
          createdAt: "2026-04-10T10:00:00.000Z",
          updatedAt: "2026-04-11T10:00:00.000Z",
          leadCount: 2,
          dealCount: 3,
          convertedDealCount: 1,
          lastActivityAt: "2026-04-11T09:00:00.000Z",
        },
      ],
      loading: false,
      error: null,
    });
  });

  async function renderDomAt(path: string) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    let root!: Root;
    await act(async () => {
      root = createRoot(container);
      root.render(
        <MemoryRouter initialEntries={[path]}>
          <PropertyListPage />
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

  it("drills the list to the selected card's predicate (?card=stale) and shows a clearable filter chip", async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const base = {
      companyId: "company-1",
      companyName: "Alpha Roofing",
      address: "123 Main St",
      city: "Dallas",
      state: "TX",
      zip: "75201",
      notes: null,
      type: "industrial",
      roofArea: 1000,
      linkedValue: "0",
      activePipelineValue: "0",
      engagementStatus: "no_engagement",
      photosCount: 0,
      isActive: true,
      createdAt: "2026-04-10T10:00:00.000Z",
      updatedAt: "2026-04-11T10:00:00.000Z",
      leadCount: 0,
      dealCount: 0,
      activeDealsCount: 0,
      convertedDealCount: 0,
    };
    mocks.usePropertiesMock.mockReturnValue({
      properties: [
        { ...base, id: "fresh", name: "Fresh Site", lastActivityAt: new Date(Date.now() - 5 * DAY).toISOString() },
        { ...base, id: "stale", name: "Stale Site", lastActivityAt: new Date(Date.now() - 60 * DAY).toISOString() },
      ],
      loading: false,
      error: null,
    });

    const { container, cleanup } = await renderDomAt("/properties?card=stale");
    try {
      // The active-filter chip names the drilled card and is clearable.
      expect(container.textContent).toContain("Filtered: Untouched 30d+");
      expect(container.querySelector('button[aria-label="Clear card filter"]')).not.toBeNull();
      // Only the stale property is listed; the fresh one is filtered out.
      expect(container.querySelector('a[href="/properties/stale"]')).not.toBeNull();
      expect(container.querySelector('a[href="/properties/fresh"]')).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("renders first-class properties instead of grouped deals", () => {
    const html = normalize(renderPage());

    expect(mocks.usePropertiesMock).toHaveBeenCalledWith({ search: undefined, type: undefined, limit: 250 });
    expect(html).toContain("1 property");
    expect(html).toContain("New Property");
    expect(html).toContain("Alpha Roofing");
    expect(html).toContain("123 Main St");
    expect(html).toContain("Industrial");
    expect(html).toContain("Won project");
  });

  it("shows a 'sq ft' roof-area badge when roof data exists (default fixture has roofArea)", () => {
    // beforeEach mock supplies one property with roofArea 125000.
    const html = normalize(renderPage());
    expect(html).toContain("sq ft");
    expect(html).not.toContain("No data");
  });

  it("shows 'No data' for roof area when no property carries a known roofArea (never a misleading '0 sq ft')", () => {
    // roof_area has no writers today (NULL by construction). The summed total is 0, which must surface
    // as "No data", not "0 sq ft". "sq ft" only renders in this summary badge, so a global assertion is safe.
    mocks.usePropertiesMock.mockReturnValue({
      properties: [
        {
          id: "property-noroof",
          companyId: "company-1",
          companyName: "Alpha Roofing",
          name: "No Roof Data",
          address: "456 Main St",
          city: "Dallas",
          state: "TX",
          zip: "75201",
          notes: null,
          type: "industrial",
          roofArea: null,
          linkedValue: "300000",
          activePipelineValue: "300000",
          engagementStatus: "active_deal",
          photosCount: 0,
          isActive: true,
          createdAt: "2026-04-10T10:00:00.000Z",
          updatedAt: "2026-04-11T10:00:00.000Z",
          leadCount: 1,
          dealCount: 1,
          convertedDealCount: 0,
          lastActivityAt: "2026-04-11T09:00:00.000Z",
        },
      ],
      loading: false,
      error: null,
    });

    const html = normalize(renderPage());
    expect(html).toContain("No data");
    expect(html).not.toContain("sq ft");
  });

  it("stacks the table into a md:hidden property card list with a touch-sized type filter", async () => {
    const { container, cleanup } = await renderPageDom();
    try {
      // Desktop keeps the full 8-col table, gated behind hidden md:block.
      const tableWrap = container.querySelector("div.hidden.md\\:block");
      expect(tableWrap?.querySelector("table")).toBeTruthy();
      // A md:hidden card list carries the same properties on phones.
      const cards = container.querySelector('[data-testid="property-cards"]');
      expect(cards).not.toBeNull();
      expect(cards?.className).toContain("md:hidden");
      expect(cards?.textContent).toContain("Dallas HQ");
      expect(cards?.textContent).toContain("Won project");
      // The whole card is a single link to the property (no nested interactive children).
      expect(cards?.querySelector('a[href="/properties/property-1"]')).toBeTruthy();
      // Type filter pills opt into the 44px touch size (reverts at md).
      const typeFilter = container.querySelector('[aria-label="Property type filter"]');
      expect(typeFilter?.querySelector("button")?.className).toContain("min-h-[44px]");
    } finally {
      await cleanup();
    }
  });

  it("uses active non-held deal counts for active opportunity totals paired with linked pipeline value", () => {
    mocks.usePropertiesMock.mockReturnValue({
      properties: [
        {
          id: "property-held",
          companyId: "company-1",
          companyName: "Alpha Roofing",
          name: "Held Mix",
          address: "123 Main St",
          city: "Dallas",
          state: "TX",
          zip: "75201",
          notes: null,
          type: "industrial",
          roofArea: 125000,
          linkedValue: "300000",
          activePipelineValue: "300000",
          engagementStatus: "active_deal",
          photosCount: 0,
          isActive: true,
          createdAt: "2026-04-10T10:00:00.000Z",
          updatedAt: "2026-04-11T10:00:00.000Z",
          leadCount: 2,
          dealCount: 3,
          activeDealsCount: 1,
          convertedDealCount: 0,
          lastActivityAt: "2026-04-11T09:00:00.000Z",
        },
      ],
      loading: false,
      error: null,
    });

    const html = normalize(renderPage());

    expect(html).toMatch(/Active opportunities.*?>3</);
    expect(html).not.toMatch(/Active opportunities.*?>5</);
  });

  it("renders visible pagination buttons with a distinct disabled state", async () => {
    mocks.usePropertiesMock.mockReturnValue({
      properties: Array.from({ length: 51 }, (_, index) => ({
        id: `property-${index + 1}`,
        companyId: "company-1",
        companyName: "Alpha Roofing",
        name: index === 0 ? "Dallas HQ" : `Dallas HQ ${index + 1}`,
        address: "123 Main St",
        city: "Dallas",
        state: "TX",
        zip: "75201",
        notes: null,
        type: "industrial",
        roofArea: 125000,
        linkedValue: "300000",
        activePipelineValue: "300000",
        engagementStatus: "won",
        photosCount: 2,
        isActive: true,
        createdAt: "2026-04-10T10:00:00.000Z",
        updatedAt: "2026-04-11T10:00:00.000Z",
        leadCount: 2,
        dealCount: 3,
        convertedDealCount: 1,
        lastActivityAt: "2026-04-11T09:00:00.000Z",
      })),
      loading: false,
      error: null,
    });
    const { container, cleanup } = await renderPageDom();
    try {
      const previousButton = container.querySelector('[aria-label="Previous properties page"]');
      const nextButton = container.querySelector('[aria-label="Next properties page"]');

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
      // Touch sizing: 44px (size-11) on phones, reverting to the compact size-8 at md.
      expect(previousButton?.className).toContain("size-11");
      expect(previousButton?.className).toContain("md:size-8");
    } finally {
      await cleanup();
    }
  });

  it("does not render pagination controls for a single page", async () => {
    const { container, cleanup } = await renderPageDom();
    try {
      expect(container.querySelector('[aria-label="Previous properties page"]')).toBeNull();
      expect(container.querySelector('[aria-label="Next properties page"]')).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("keeps the next button visibly disabled on the last page", async () => {
    mocks.usePropertiesMock.mockReturnValue({
      properties: Array.from({ length: 51 }, (_, index) => ({
        id: `property-${index + 1}`,
        companyId: "company-1",
        companyName: "Alpha Roofing",
        name: index === 0 ? "Dallas HQ" : `Dallas HQ ${index + 1}`,
        address: "123 Main St",
        city: "Dallas",
        state: "TX",
        zip: "75201",
        notes: null,
        type: "industrial",
        roofArea: 125000,
        linkedValue: "300000",
        activePipelineValue: "300000",
        engagementStatus: "won",
        photosCount: 2,
        isActive: true,
        createdAt: "2026-04-10T10:00:00.000Z",
        updatedAt: "2026-04-11T10:00:00.000Z",
        leadCount: 2,
        dealCount: 3,
        convertedDealCount: 1,
        lastActivityAt: "2026-04-11T09:00:00.000Z",
      })),
      loading: false,
      error: null,
    });
    const { container, cleanup } = await renderPageDom();
    try {
      const firstNextButton = container.querySelector<HTMLButtonElement>('[aria-label="Next properties page"]');
      await act(async () => {
        firstNextButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      const nextButton = container.querySelector<HTMLButtonElement>('[aria-label="Next properties page"]');
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
