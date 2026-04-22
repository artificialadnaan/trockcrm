import { describe, expect, it, vi } from "vitest";
import propertySelectorSource from "./property-selector.tsx?raw";
import { resolveSelectedPropertyLabel } from "./property-selector";

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: apiMock,
}));

function normalize(source: string) {
  return source.replace(/\s+/g, " ").trim();
}

describe("PropertySelector inline create", () => {
  it("preserves the created property label until the refetch catches up", () => {
    const source = normalize(propertySelectorSource);

    expect(source).toContain("const { properties, loading, refetch } = useProperties");
    expect(source).toContain("resolveSelectedPropertyLabel");
    expect(source).toContain("if (match) { return formatPropertyLabel(match); }");
    expect(source).toContain("void refetch();");
  });

  it("uses a small search-driven property query instead of preloading hundreds of records", () => {
    const source = normalize(propertySelectorSource);

    expect(source).toContain("useDeferredValue");
    expect(source).toContain("search: deferredQuery || undefined");
    expect(source).toContain("limit: 25");
    expect(source).not.toContain("limit: 500");
  });

  it("hydrates a selected property label from the API when it is outside the current search slice", async () => {
    apiMock.mockResolvedValueOnce({
      property: {
        id: "property-99",
        companyId: "company-1",
        companyName: "Dallas",
        name: "Remote Property",
        address: "123 Main St",
        city: "Dallas",
        state: "TX",
        zip: "75001",
        notes: null,
        isActive: true,
        createdAt: "",
        updatedAt: "",
        leadCount: 0,
        dealCount: 0,
        convertedDealCount: 0,
        lastActivityAt: null,
      },
    });

    const label = await resolveSelectedPropertyLabel("property-99", []);

    expect(apiMock).toHaveBeenCalledWith("/properties/property-99");
    expect(label).toContain("123 Main St");
    expect(label).toContain("Dallas, TX");
  });
});
