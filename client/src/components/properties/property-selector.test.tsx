import { describe, expect, it, vi } from "vitest";
import propertySelectorSource from "./property-selector.tsx?raw";
import {
  getMissingPropertyAddressFields,
  getPropertySelectorLabel,
  resolveSelectedPropertyLabel,
  resolveSelectedPropertySelection,
  sortPropertiesForSelection,
} from "./property-selector";

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
    expect(source).toContain("resolveSelectedPropertySelection");
    expect(source).toContain("property: match as PropertySelectorRecord");
    expect(source).toContain("void refetch();");
  });

  it("uses a small search-driven property query instead of preloading hundreds of records", () => {
    const source = normalize(propertySelectorSource);

    expect(source).toContain("useDeferredValue");
    expect(source).toContain("search: deferredQuery || undefined");
    expect(source).toContain("limit: 25");
    expect(source).not.toContain("limit: 500");
  });

  it("truncates long selected property labels inside the selector button", () => {
    const source = normalize(propertySelectorSource);

    expect(source).toContain("min-w-0 flex-1 truncate text-left");
    expect(source).toContain("title={selectedLabel ?? undefined}");
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

    expect(apiMock).toHaveBeenCalledWith("/properties/property-99", {});
    expect(label).toContain("123 Main St");
    expect(label).toContain("Dallas, TX");
  });

  it("hydrates a selected property label with the selected-office tenant header", async () => {
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

    await resolveSelectedPropertyLabel("property-99", [], "office-atlanta");

    expect(apiMock).toHaveBeenCalledWith("/properties/property-99", {
      headers: { "x-office-id": "office-atlanta" },
    });
  });

  it("returns the selected property record while hydrating the selected label", async () => {
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

    const selection = await resolveSelectedPropertySelection("property-99", [], "office-atlanta");

    expect(selection.label).toContain("123 Main St");
    expect(selection.property).toMatchObject({
      id: "property-99",
      address: "123 Main St",
      city: "Dallas",
      state: "TX",
      zip: "75001",
    });
  });

  it("labels incomplete address properties with company, property name, location, and warning text", () => {
    const label = getPropertySelectorLabel({
      id: "property-1",
      companyId: "company-1",
      companyName: "Radco",
      name: "Peachtree Corners Property",
      address: null,
      city: "Peachtree Corners",
      state: "GA",
      zip: null,
      notes: null,
      isActive: true,
      createdAt: "",
      updatedAt: "",
      leadCount: 0,
      dealCount: 0,
      convertedDealCount: 0,
      lastActivityAt: null,
      buildYear: null,
      unitCount: null,
    });

    expect(label).toBe("Radco - Peachtree Corners Property - Peachtree Corners, GA (incomplete address)");
  });

  it("sorts complete address properties before incomplete address properties", () => {
    const complete = {
      id: "complete",
      name: "Complete",
      address: "123 Main",
      city: "Dallas",
      state: "TX",
      zip: "75201",
      companyName: "Acme",
    };
    const incomplete = {
      id: "incomplete",
      name: "Incomplete",
      address: null,
      city: "Peachtree Corners",
      state: "GA",
      zip: null,
      companyName: "Radco",
    };

    expect(sortPropertiesForSelection([incomplete, complete]).map((property) => property.id)).toEqual([
      "complete",
      "incomplete",
    ]);
  });

  it("returns the exact address fields that need inline repair", () => {
    expect(
      getMissingPropertyAddressFields({
        address: null,
        city: "Peachtree Corners",
        state: "GA",
        zip: null,
      })
    ).toEqual(["address", "zip"]);
  });
});
