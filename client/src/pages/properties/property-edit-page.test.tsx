// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PropertyEditPage } from "./property-edit-page";

// Detail-route probe: echoes the URL query so a test can assert ?officeId survived the save navigate.
function DetailProbe() {
  const loc = useLocation();
  return <div>DETAIL{loc.search}</div>;
}

const mocks = vi.hoisted(() => ({
  usePropertyDetail: vi.fn(),
  updateProperty: vi.fn(),
}));

vi.mock("@/hooks/use-properties", () => ({
  usePropertyDetail: mocks.usePropertyDetail,
  updateProperty: mocks.updateProperty,
}));

const PROPERTY = {
  id: "property-1",
  name: "Maple Court Apartments",
  address: "123 Main St",
  city: "Dallas",
  state: "TX",
  zip: "75001",
  buildYear: 2005,
  unitCount: 120,
};

function tree(initial: string) {
  return (
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/properties/:id/edit" element={<PropertyEditPage />} />
        <Route path="/properties/:id" element={<DetailProbe />} />
      </Routes>
    </MemoryRouter>
  );
}

let container: HTMLDivElement;
let root: Root;

function mount(initial = "/properties/property-1/edit") {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(tree(initial));
  });
}

function input(id: string) {
  return container.querySelector(`#${id}`) as HTMLInputElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.usePropertyDetail.mockReturnValue({ property: PROPERTY, loading: false, error: null });
  mocks.updateProperty.mockResolvedValue({ property: PROPERTY });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe("PropertyEditPage", () => {
  // The bug: /properties/:id/edit had no route, so Edit fell through to the catch-all and redirected
  // to the dashboard. This proves the page now renders an editable form prefilled with the property.
  it("renders an editable form prefilled with the property's values", () => {
    mount();
    expect(container.textContent).toContain("Edit Property");
    expect(container.textContent).toContain("Maple Court Apartments");
    expect(input("address").value).toBe("123 Main St");
    expect(input("city").value).toBe("Dallas");
    expect(input("state").value).toBe("TX");
    expect(input("zip").value).toBe("75001");
    expect(input("buildYear").value).toBe("2005");
    expect(input("unitCount").value).toBe("120");
  });

  it("saves via updateProperty with the numeric fields parsed to numbers", async () => {
    mount();
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(mocks.updateProperty).toHaveBeenCalledWith("property-1", {
      address: "123 Main St",
      city: "Dallas",
      state: "TX",
      zip: "75001",
      buildYear: 2005,
      unitCount: 120,
    });
  });

  // The server treats address/city/state/zip as required-when-present (blank → 400), so editing an
  // incomplete property (here: no city/state/zip) must omit those blank keys, not send them as null.
  it("omits blank address fields so editing an incomplete property does not 400", async () => {
    mocks.usePropertyDetail.mockReturnValue({
      property: { ...PROPERTY, city: "", state: "", zip: "" },
      loading: false,
      error: null,
    });
    mount();
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    const payload = mocks.updateProperty.mock.calls[0]![1];
    expect(payload).not.toHaveProperty("city");
    expect(payload).not.toHaveProperty("state");
    expect(payload).not.toHaveProperty("zip");
    expect(payload).toMatchObject({ address: "123 Main St", buildYear: 2005, unitCount: 120 });
  });

  // api() resolves the office from the URL, so a cross-office save must return to the detail page with
  // ?officeId intact — otherwise the director lands in the wrong office and sees a not-found view.
  it("preserves the ?officeId query param when returning to the detail page after save", async () => {
    mount("/properties/property-1/edit?officeId=atl-office");
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(container.textContent).toContain("DETAIL?officeId=atl-office");
  });
});
