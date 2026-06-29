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
  notes: "Roof inspected 2023",
  isActive: true,
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

// Set a controlled input/textarea's value the way React detects it (native setter + input event).
function setInput(id: string, value: string) {
  const el = container.querySelector(`#${id}`) as HTMLInputElement | HTMLTextAreaElement;
  const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function submit() {
  container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
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
    expect(input("buildYear").value).toBe("2005");
    expect(input("unitCount").value).toBe("120");
  });

  it("sends only the field the user changed", async () => {
    mount();
    await act(async () => setInput("buildYear", "2010"));
    await act(async () => submit());
    expect(mocks.updateProperty).toHaveBeenCalledWith("property-1", { buildYear: 2010 });
  });

  it("saves edited notes", async () => {
    mount();
    await act(async () => setInput("notes", "Updated note"));
    await act(async () => submit());
    expect(mocks.updateProperty).toHaveBeenCalledWith("property-1", { notes: "Updated note" });
  });

  // L78: a property carrying legacy-invalid building data (unitCount 0 is rejected server-side) must
  // still be editable on another field — the unchanged invalid value must NOT be resent.
  it("does not resend unchanged building data when only an address field changes", async () => {
    mocks.usePropertyDetail.mockReturnValue({
      property: { ...PROPERTY, unitCount: 0 },
      loading: false,
      error: null,
    });
    mount();
    await act(async () => setInput("address", "456 Oak Ave"));
    await act(async () => submit());
    expect(mocks.updateProperty).toHaveBeenCalledWith("property-1", { address: "456 Oak Ave" });
  });

  // A whitespace-only legacy field must not be treated as "changed" on an untouched save (raw compare),
  // or it would be sent as null and 400 on "<Field> cannot be blank when provided".
  it("does not resend a whitespace-only legacy field on an unrelated save", async () => {
    mocks.usePropertyDetail.mockReturnValue({
      property: { ...PROPERTY, city: "  " },
      loading: false,
      error: null,
    });
    mount();
    await act(async () => setInput("buildYear", "2010"));
    await act(async () => submit());
    expect(mocks.updateProperty).toHaveBeenCalledWith("property-1", { buildYear: 2010 });
  });

  // api() resolves the office from the URL, so a cross-office save must return with ?officeId intact —
  // otherwise the director lands in the wrong office and sees a not-found view.
  it("preserves the ?officeId query param when returning to the detail page after save", async () => {
    mount("/properties/property-1/edit?officeId=atl-office");
    await act(async () => submit());
    expect(container.textContent).toContain("DETAIL?officeId=atl-office");
  });

  // L109: soft-deleted properties are read-only — show a message instead of an editable form.
  it("blocks editing a soft-deleted (inactive) property", () => {
    mocks.usePropertyDetail.mockReturnValue({
      property: { ...PROPERTY, isActive: false },
      loading: false,
      error: null,
    });
    mount();
    expect(container.textContent).toContain("has been deleted");
    expect(container.querySelector("form")).toBeNull();
  });
});
