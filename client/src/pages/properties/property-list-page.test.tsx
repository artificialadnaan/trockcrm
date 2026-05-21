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
      expect(previousButton?.className).toContain("text-primary");
      expect(previousButton?.className).toContain("disabled:bg-muted");
      expect(previousButton?.className).toContain("disabled:text-muted-foreground");
      expect(nextButton?.className).toContain("text-primary");
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
      expect(nextButton?.className).toContain("text-primary");
      expect(nextButton?.className).toContain("disabled:bg-muted");
      expect(nextButton?.className).toContain("disabled:text-muted-foreground");
    } finally {
      await cleanup();
    }
  });
});
