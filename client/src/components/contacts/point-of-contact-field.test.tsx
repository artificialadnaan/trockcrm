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

// The dialog's contents render through a Base UI Portal into document.body, not as a DOM descendant of
// `container` (same reality as deal-billing-tab.test.tsx's Dialog assertions) — so anything inside the
// dialog is queried off `document`, not `container`.
function setFieldValue(testId: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(`[data-testid='${testId}']`)!;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
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

  it("creates the contact against the selected company and selects it", async () => {
    const onChange = vi.fn();
    const refetch = vi.fn();
    mocks.useCompanyContacts.mockReturnValue({ contacts: [], loading: false, error: null, refetch });
    mocks.createContact.mockResolvedValue({ contact: { id: "contact-9", firstName: "Ada", lastName: "Lowe" } });
    render({ onChange });

    act(() => container.querySelector<HTMLButtonElement>("[data-testid='poc-add-button']")!.click());
    setFieldValue("poc-first-name", "Ada");
    setFieldValue("poc-last-name", "Lowe");
    await act(async () => {
      document.querySelector<HTMLButtonElement>("[data-testid='poc-save']")!.click();
    });

    // companyId is what keeps the new contact valid against the server's company-membership check.
    expect(mocks.createContact).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: "Ada", lastName: "Lowe", companyId: "company-1", category: "client" }),
      { officeId: "office-1" }
    );
    // Dedup must NOT be skipped on the first attempt.
    expect(mocks.createContact.mock.calls[0][0].skipDedupCheck).toBeFalsy();
    expect(refetch).toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith("contact-9");
  });

  it("shows duplicate suggestions instead of selecting nothing when dedup blocks the create", async () => {
    mocks.useCompanyContacts.mockReturnValue({ contacts: [], loading: false, error: null, refetch: vi.fn() });
    mocks.createContact.mockResolvedValue({
      contact: null,
      dedupWarning: true,
      suggestions: [
        { id: "contact-5", firstName: "Ada", lastName: "Lowe", email: null, companyName: "Acme", matchReason: "same name", isActive: true },
        { id: "contact-6", firstName: "Ada", lastName: "Lowe", email: null, companyName: "Old", matchReason: "same name", isActive: false },
      ],
    });
    const onChange = vi.fn();
    render({ onChange });

    act(() => container.querySelector<HTMLButtonElement>("[data-testid='poc-add-button']")!.click());
    setFieldValue("poc-first-name", "Ada");
    setFieldValue("poc-last-name", "Lowe");
    await act(async () => {
      document.querySelector<HTMLButtonElement>("[data-testid='poc-save']")!.click();
    });

    expect(onChange).not.toHaveBeenCalled();
    // Only ACTIVE suggestions are offered — assigning a soft-deleted/merged record would point the deal at
    // a stale contact.
    const offered = document.querySelectorAll("[data-testid='poc-suggestion']");
    expect(offered.length).toBe(1);
    expect(document.body.textContent).toContain("Acme");
    expect(document.body.textContent).not.toContain("Old");
  });

  it("requires a first and last name before it will call the API", async () => {
    mocks.useCompanyContacts.mockReturnValue({ contacts: [], loading: false, error: null, refetch: vi.fn() });
    render();

    act(() => container.querySelector<HTMLButtonElement>("[data-testid='poc-add-button']")!.click());
    await act(async () => {
      document.querySelector<HTMLButtonElement>("[data-testid='poc-save']")!.click();
    });

    expect(mocks.createContact).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("First and last name are required");
  });
});
