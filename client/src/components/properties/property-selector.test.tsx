/**
 * @vitest-environment jsdom
 */
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import propertySelectorSource from "./property-selector.tsx?raw";
import {
  getMissingPropertyAddressFields,
  getPropertySelectorLabel,
  PropertySelector,
  resolveSelectedPropertyLabel,
  resolveSelectedPropertySelection,
  sortPropertiesForSelection,
} from "./property-selector";
import type { PropertySurface } from "@/hooks/use-properties";

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn(),
}));

// Controllable backing state for the mocked useProperties hook + a stub updateProperty so the interactive
// tests can drive the catch-net flow without a network layer. Hoisted so the vi.mock factory can read it.
const propertyHook = vi.hoisted(() => ({
  list: [] as unknown[],
  updateProperty: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: apiMock,
}));

// IMPORTANT: keep the REAL formatPropertyLabel + PropertySurface type (the existing pure-function tests
// assert real label output, e.g. "123 Main St" / "Dallas, TX"); only override the hook + the writer.
vi.mock("@/hooks/use-properties", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/use-properties")>("@/hooks/use-properties");
  return {
    ...actual,
    useProperties: () => ({ properties: propertyHook.list, loading: false, refetch: propertyHook.refetch }),
    updateProperty: propertyHook.updateProperty,
  };
});

// The dropdown renders the create dialog; stub it out so it contributes no buttons/DOM to the interactive
// assertions.
vi.mock("./property-create-dialog", () => ({
  PropertyCreateDialog: () => null,
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

describe("PropertySelector Complete-property catch-net (interactive)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let onChangeSpy: ReturnType<typeof vi.fn<(propertyId: string) => void>>;

  function buildProperty(overrides: Partial<PropertySurface> & { id: string }): PropertySurface {
    return {
      companyId: "c1",
      companyName: "Acme",
      name: "Sample Property",
      address: "123 Main St",
      city: "Dallas",
      state: "TX",
      zip: "75001",
      buildYear: 2000,
      unitCount: 100,
      notes: null,
      isActive: true,
      createdAt: "",
      updatedAt: "",
      leadCount: 0,
      dealCount: 0,
      convertedDealCount: 0,
      lastActivityAt: null,
      ...overrides,
    };
  }

  // A property created by the lead-create flow: valid address, but no build year / unit count yet.
  function incompleteLeadCreateProperty(overrides: Partial<PropertySurface> & { id: string }): PropertySurface {
    return buildProperty({ buildYear: null, unitCount: null, ...overrides });
  }

  function renderSelector(value: string | null) {
    const element = (
      <PropertySelector
        companyId="c1"
        value={value}
        onChange={onChangeSpy}
        officeId="office-dallas"
        requireLeadCreateFields
      />
    );
    if (!root) {
      act(() => {
        root = createRoot(container);
        root.render(element);
      });
    } else {
      const current = root;
      act(() => {
        current.render(element);
      });
    }
  }

  // Flush microtasks (the async value-resolution promise) + the follow-up effects (catch-net) a few times.
  async function flush(times = 4) {
    for (let i = 0; i < times; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  async function clickButton(button: HTMLButtonElement) {
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  async function setInputValue(input: HTMLInputElement, value: string) {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  function findButtonByText(text: string) {
    return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === text
    );
  }

  function findButtonContaining(text: string) {
    return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes(text)
    );
  }

  function yearBuiltInput() {
    return container.querySelector<HTMLInputElement>('input[aria-label="Property year built"]');
  }

  function unitCountInput() {
    return container.querySelector<HTMLInputElement>('input[aria-label="Property number of units"]');
  }

  function addressInput() {
    return container.querySelector<HTMLInputElement>('input[aria-label="Property street address"]');
  }

  function editorOpen() {
    return container.textContent?.includes("Complete property") ?? false;
  }

  beforeEach(() => {
    propertyHook.list = [];
    propertyHook.updateProperty.mockReset();
    propertyHook.refetch.mockReset();
    apiMock.mockReset();
    onChangeSpy = vi.fn<(propertyId: string) => void>();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    if (root) {
      const current = root;
      await act(async () => {
        current.unmount();
      });
    }
    root = null;
    container.remove();
  });

  // #1 — MUST LAND: a consolidated save persists all six fields via a single updateProperty call.
  it("persists all six fields via one updateProperty call when completing an incomplete property from the dropdown", async () => {
    const incomplete = incompleteLeadCreateProperty({ id: "p1", name: "Incomplete Prop" });
    propertyHook.list = [incomplete];
    propertyHook.updateProperty.mockResolvedValue({
      property: { ...incomplete, buildYear: 1990, unitCount: 10 },
    });

    renderSelector(null);
    await flush();

    // Open the dropdown via the trigger button (first button — the placeholder trigger).
    const trigger = container.querySelector<HTMLButtonElement>("button");
    expect(trigger).toBeTruthy();
    await clickButton(trigger!);
    await flush();

    // Click the incomplete property row (its label is the formatted address line).
    const row = findButtonContaining("123 Main St");
    expect(row).toBeTruthy();
    await clickButton(row!);
    await flush();

    // The repair editor renders the two missing lead-create inputs (address is already valid).
    expect(addressInput()).toBeNull();
    const year = yearBuiltInput();
    const units = unitCountInput();
    expect(year).toBeTruthy();
    expect(units).toBeTruthy();

    await setInputValue(year!, "1990");
    await setInputValue(units!, "10");

    const complete = findButtonByText("Complete property");
    expect(complete).toBeTruthy();
    await clickButton(complete!);
    await flush();

    expect(propertyHook.updateProperty).toHaveBeenCalledTimes(1);
    expect(propertyHook.updateProperty).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({
        address: "123 Main St",
        city: "Dallas",
        state: "TX",
        zip: "75001",
        buildYear: 1990,
        unitCount: 10,
      }),
      { officeId: "office-dallas" }
    );
    expect(onChangeSpy).toHaveBeenCalledWith("p1");
  });

  // #2 — MUST LAND: catch-net opens the repair editor for an incomplete AUTO-SELECTED value, no click.
  it("opens the repair editor automatically for an incomplete pre-selected value (catch-net)", async () => {
    const incomplete = incompleteLeadCreateProperty({ id: "p2", name: "Auto Selected" });
    propertyHook.list = [incomplete];

    renderSelector("p2");
    await flush();

    expect(editorOpen()).toBe(true);
    expect(yearBuiltInput()).toBeTruthy();
    expect(unitCountInput()).toBeTruthy();
  });

  // #3 — Cancel dismisses the editor for the current value and it does NOT reopen.
  it("does not reopen the repair editor after Cancel for the same value", async () => {
    const incomplete = incompleteLeadCreateProperty({ id: "p3", name: "Cancelled Prop" });
    propertyHook.list = [incomplete];

    renderSelector("p3");
    await flush();
    expect(editorOpen()).toBe(true);

    const cancel = findButtonByText("Cancel");
    expect(cancel).toBeTruthy();
    await clickButton(cancel!);
    await flush();

    expect(editorOpen()).toBe(false);
    expect(yearBuiltInput()).toBeNull();

    // Stays dismissed across further effect flushes (dismissal is keyed to this value).
    await flush();
    expect(yearBuiltInput()).toBeNull();
  });

  // #4 — A -> B(complete) -> A re-select re-prompts: the value-change effect clears a STALE dismissal.
  // Faithful regression guard for the round-3 bug. After cancelling A (dismissal=A), navigating to a
  // COMPLETE property B opens no editor and sets no dismissal; the A->B value change is what clears the
  // stale dismissal=A. Returning to A then re-prompts ONLY because of that clear — without the value-change
  // effect, dismissal===A would suppress the second A selection (the exact regression).
  // B MUST be complete and MUST NOT be cancelled: if B were incomplete-and-cancelled, dismissal would end up
  // ===B and the test would pass even without the fix (i.e. it would not guard the regression).
  it("re-prompts for A after navigating A -> B(complete) -> A (stale dismissal cleared)", async () => {
    const propA = incompleteLeadCreateProperty({ id: "pA", name: "Property A" });
    const propB = buildProperty({ id: "pB", name: "Property B" }); // complete: nothing to repair
    propertyHook.list = [propA, propB];

    // Select A -> catch-net opens for A.
    renderSelector("pA");
    await flush();
    expect(editorOpen()).toBe(true);
    expect(yearBuiltInput()).toBeTruthy();

    // Cancel A -> dismissed for A, editor closed.
    await clickButton(findButtonByText("Cancel")!);
    await flush();
    expect(editorOpen()).toBe(false);

    // Navigate to a COMPLETE property B -> no editor opens (nothing missing). This A->B transition clears
    // A's stale dismissal.
    renderSelector("pB");
    await flush();
    expect(editorOpen()).toBe(false);

    // Back to A -> the stale dismissal is gone, so the catch-net RE-PROMPTS for A.
    renderSelector("pA");
    await flush();
    expect(editorOpen()).toBe(true);
    expect(yearBuiltInput()).toBeTruthy();
  });
});
