// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PropertyEditPage } from "./property-edit-page";

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
        <Route path="/properties/:id" element={<div>DETAIL PAGE</div>} />
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
});
