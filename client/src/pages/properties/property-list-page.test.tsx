import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { PropertyListPage } from "./property-list-page";

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

    expect(mocks.usePropertiesMock).toHaveBeenCalledWith({ search: "" });
    expect(html).toContain("1 property across 3 deals");
    expect(html).toContain("Alpha Roofing");
    expect(html).toContain("123 Main St");
    expect(html).toContain("2 leads");
  });
});
