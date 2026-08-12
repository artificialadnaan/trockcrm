/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PointOfContactField } from "./point-of-contact-field";

const mocks = vi.hoisted(() => ({
  useCompanyContacts: vi.fn(),
  createContact: vi.fn(),
}));

vi.mock("@/hooks/use-companies", () => ({ useCompanyContacts: mocks.useCompanyContacts }));
vi.mock("@/hooks/use-contacts", () => ({ createContact: mocks.createContact }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.useCompanyContacts.mockReturnValue({
    contacts: [
      { id: "contact-1", firstName: "Dana", lastName: "Reyes", email: null, phone: null, jobTitle: null, category: "client" },
    ],
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

function render(props: Partial<React.ComponentProps<typeof PointOfContactField>> = {}) {
  act(() => {
    root.render(
      <PointOfContactField
        companyId="company-1"
        value=""
        onChange={vi.fn()}
        officeId="office-1"
        {...props}
      />
    );
  });
}

describe("PointOfContactField", () => {
  it("tells the rep to pick a company first, and disables the add button and the select trigger, when there is no company", () => {
    render({ companyId: "" });
    expect(container.textContent).toContain("Select a company first");
    const addButton = container.querySelector<HTMLButtonElement>("[data-testid='poc-add-button']");
    expect(addButton?.disabled).toBe(true);
    // The trigger renders as a real <button> (Base UI's SelectTrigger with nativeButton, verified by
    // inspecting the rendered DOM), so the native `disabled` property reflects the Select's own
    // `disabled` prop directly — not just the add button's independently-computed one.
    const selectTrigger = container.querySelector<HTMLButtonElement>("[data-testid='poc-select']");
    expect(selectTrigger?.disabled).toBe(true);
  });

  it("does not query for contacts when no company is selected", () => {
    render({ companyId: "" });
    // undefined, not "" — useCompanyContacts skips the request entirely on a falsy id, and passing ""
    // would still be a distinct cache key that fetches nothing useful.
    expect(mocks.useCompanyContacts).toHaveBeenCalledWith(undefined, { officeId: "office-1" });
  });

  it("scopes the contact list to the selected company, and enables the select trigger", () => {
    render({ companyId: "company-1" });
    expect(mocks.useCompanyContacts).toHaveBeenCalledWith("company-1", { officeId: "office-1" });
    // Mirror of the no-company case above: without this, a trigger disabled unconditionally
    // (rather than on `!companyId`) would still pass every other assertion in this suite.
    const selectTrigger = container.querySelector<HTMLButtonElement>("[data-testid='poc-select']");
    expect(selectTrigger?.disabled).toBe(false);
  });

  it("offers adding a contact when the company has none", () => {
    mocks.useCompanyContacts.mockReturnValue({ contacts: [], loading: false, error: null, refetch: vi.fn() });
    render();
    expect(container.textContent).toContain("No contacts on this company yet");
    expect(container.querySelector<HTMLButtonElement>("[data-testid='poc-add-button']")?.disabled).toBe(false);
  });
});
