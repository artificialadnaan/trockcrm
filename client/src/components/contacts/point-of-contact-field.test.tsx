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

  // CRITICAL 1 (review of 13fee5bdb): editing the draft after a dedup warning must drop the warning, so a
  // later save on a DIFFERENT, unreviewed name cannot silently reuse "Create anyway" and skip dedup.
  it("forces past dedup for the reviewed name, but reverts to a real dedup check after the name is edited", async () => {
    mocks.useCompanyContacts.mockReturnValue({ contacts: [], loading: false, error: null, refetch: vi.fn() });
    mocks.createContact.mockResolvedValue({
      contact: null,
      dedupWarning: true,
      suggestions: [
        { id: "contact-5", firstName: "Ada", lastName: "Lowe", email: null, companyName: "Acme", linkedCompanyName: null, matchReason: "same name", isActive: true },
      ],
    });
    render();

    act(() => container.querySelector<HTMLButtonElement>("[data-testid='poc-add-button']")!.click());
    setFieldValue("poc-first-name", "Ada");
    setFieldValue("poc-last-name", "Lowe");
    await act(async () => {
      document.querySelector<HTMLButtonElement>("[data-testid='poc-save']")!.click();
    });
    expect(mocks.createContact.mock.calls[0][0].skipDedupCheck).toBeFalsy();

    // "Create anyway" on the SAME (reviewed) name forces past the warning it just saw.
    await act(async () => {
      document.querySelector<HTMLButtonElement>("[data-testid='poc-save']")!.click();
    });
    expect(mocks.createContact.mock.calls[1][0].skipDedupCheck).toBe(true);

    // The rep realizes it's the wrong person and edits the name — dedup has never evaluated "Adam Lowell",
    // so this save must NOT inherit the "Create anyway" force from the stale warning.
    setFieldValue("poc-first-name", "Adam");
    setFieldValue("poc-last-name", "Lowell");
    await act(async () => {
      document.querySelector<HTMLButtonElement>("[data-testid='poc-save']")!.click();
    });
    expect(mocks.createContact.mock.calls[2][0].skipDedupCheck).toBeFalsy();
  });

  // CRITICAL 2 (review of 13fee5bdb): when dedup fires but every match it found is inactive (soft-deleted or
  // merged), there is nothing left to OFFER — but the rep must still get a visible message and a way forward,
  // not a "Save contact" button that repeats the same silent no-op forever.
  it("tells the rep about an archived match and offers 'Create anyway' when every dedup suggestion is inactive", async () => {
    mocks.useCompanyContacts.mockReturnValue({ contacts: [], loading: false, error: null, refetch: vi.fn() });
    mocks.createContact.mockResolvedValue({
      contact: null,
      dedupWarning: true,
      suggestions: [
        { id: "contact-6", firstName: "Ada", lastName: "Lowe", email: null, companyName: "Old", linkedCompanyName: null, matchReason: "same name", isActive: false },
      ],
    });
    render();

    act(() => container.querySelector<HTMLButtonElement>("[data-testid='poc-add-button']")!.click());
    setFieldValue("poc-first-name", "Ada");
    setFieldValue("poc-last-name", "Lowe");
    await act(async () => {
      document.querySelector<HTMLButtonElement>("[data-testid='poc-save']")!.click();
    });

    // Nothing pickable is offered (the only match is archived) ...
    expect(document.querySelectorAll("[data-testid='poc-suggestion']").length).toBe(0);
    // ... but the rep is told why, and the button has switched to force past it.
    expect(document.body.textContent).toContain("archived");
    expect(document.querySelector<HTMLButtonElement>("[data-testid='poc-save']")!.textContent).toContain("Create anyway");
  });

  // CRITICAL 4 (review of 13fee5bdb): a suggestion from another company is informational only. Picking it
  // would set `value` to an id the company-scoped picker doesn't list (the trigger would show "Select a
  // point of contact" while `value` is silently set to someone else's company), and saving would 400.
  it("offers 'Use this contact' only for an in-company suggestion, not a cross-company one", async () => {
    mocks.useCompanyContacts.mockReturnValue({
      contacts: [{ id: "contact-1", firstName: "Dana", lastName: "Reyes", email: null, phone: null, jobTitle: null, category: "client" }],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mocks.createContact.mockResolvedValue({
      contact: null,
      dedupWarning: true,
      suggestions: [
        // Same id as a contact already in the company-scoped list above — in-company.
        { id: "contact-1", firstName: "Dana", lastName: "Reyes", email: null, companyName: null, linkedCompanyName: "Acme Co", matchReason: "same name", isActive: true },
        // Not in the company-scoped list — cross-company.
        { id: "contact-7", firstName: "Dana", lastName: "Reyes", email: null, companyName: null, linkedCompanyName: "Other Co", matchReason: "same name", isActive: true },
      ],
    });
    render();

    act(() => container.querySelector<HTMLButtonElement>("[data-testid='poc-add-button']")!.click());
    setFieldValue("poc-first-name", "Dana");
    setFieldValue("poc-last-name", "Reyes");
    await act(async () => {
      document.querySelector<HTMLButtonElement>("[data-testid='poc-save']")!.click();
    });

    const rows = Array.from(document.querySelectorAll("[data-testid='poc-suggestion']"));
    expect(rows.length).toBe(2);
    const inCompanyRow = rows.find((r) => r.textContent?.includes("Acme Co"));
    const crossCompanyRow = rows.find((r) => r.textContent?.includes("Other Co"));
    expect(inCompanyRow?.querySelector("button")).not.toBeNull();
    expect(crossCompanyRow?.querySelector("button")).toBeNull();
  });

  // IMPORTANT 5 (review of 13fee5bdb): a failed contacts load must not look identical to "this company
  // genuinely has no contacts" — that message tells the rep to create someone who probably already exists.
  it("shows a retryable error state, not the empty-company state, when loading contacts fails", () => {
    const refetch = vi.fn();
    mocks.useCompanyContacts.mockReturnValue({ contacts: [], loading: false, error: "network error", refetch });
    render();

    expect(container.textContent).not.toContain("No contacts on this company yet");
    const errorBox = container.querySelector("[data-testid='poc-load-error']");
    expect(errorBox).not.toBeNull();
    act(() => container.querySelector<HTMLButtonElement>("[data-testid='poc-retry']")!.click());
    expect(refetch).toHaveBeenCalled();
  });

  // IMPORTANT 3 (review of 13fee5bdb): a suggestion pick must not be racable against an in-flight
  // "Create anyway" — the button that would fire onChange with a freshly minted duplicate is disabled while
  // that request is outstanding.
  it("disables 'Use this contact' while a create is saving", async () => {
    // In-company (id present in the company-scoped list) so "Use this contact" actually renders — a
    // cross-company suggestion never gets that button at all (Critical 4).
    mocks.useCompanyContacts.mockReturnValue({
      contacts: [{ id: "contact-5", firstName: "Ada", lastName: "Lowe", email: null, phone: null, jobTitle: null, category: "client" }],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mocks.createContact.mockResolvedValueOnce({
      contact: null,
      dedupWarning: true,
      suggestions: [
        { id: "contact-5", firstName: "Ada", lastName: "Lowe", email: null, companyName: "Acme", linkedCompanyName: null, matchReason: "same name", isActive: true },
      ],
    });
    render();

    act(() => container.querySelector<HTMLButtonElement>("[data-testid='poc-add-button']")!.click());
    setFieldValue("poc-first-name", "Ada");
    setFieldValue("poc-last-name", "Lowe");
    await act(async () => {
      document.querySelector<HTMLButtonElement>("[data-testid='poc-save']")!.click();
    });

    // "Create anyway" kicks off a second create that won't resolve during this assertion.
    let resolveSecond: (v: unknown) => void = () => {};
    mocks.createContact.mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
    act(() => {
      document.querySelector<HTMLButtonElement>("[data-testid='poc-save']")!.click();
    });

    const suggestionButton = document.querySelector<HTMLButtonElement>("[data-testid='poc-suggestion'] button");
    expect(suggestionButton?.disabled).toBe(true);

    await act(async () => {
      resolveSecond({ contact: { id: "contact-9", firstName: "Ada", lastName: "Lowe" } });
    });
  });

  it("re-enables the dialog after a successful create, so a second contact can be added", async () => {
    // closeDialog() bumps saveSeq, which is exactly what makes saveNewContact's `finally` skip its own
    // setSaving(false) — so a successful create used to leave `saving` true forever and every later reopen
    // came up with its inputs and Save button permanently disabled.
    mocks.useCompanyContacts.mockReturnValue({ contacts: [], loading: false, error: null, refetch: vi.fn() });
    mocks.createContact.mockResolvedValue({ contact: { id: "contact-9", firstName: "Ada", lastName: "Lowe" } });
    render();

    act(() => container.querySelector<HTMLButtonElement>("[data-testid='poc-add-button']")!.click());
    setFieldValue("poc-first-name", "Ada");
    setFieldValue("poc-last-name", "Lowe");
    await act(async () => {
      document.querySelector<HTMLButtonElement>("[data-testid='poc-save']")!.click();
    });

    act(() => container.querySelector<HTMLButtonElement>("[data-testid='poc-add-button']")!.click());

    expect(document.querySelector<HTMLButtonElement>("[data-testid='poc-save']")?.disabled).toBe(false);
    expect(document.querySelector<HTMLInputElement>("[data-testid='poc-first-name']")?.disabled).toBe(false);
  });

  it("does not select a newly created contact if the dialog was closed during the refetch", async () => {
    // The dialog's own close button and Escape stay live while refetch() is pending, and closing bumps
    // saveSeq. Without a SECOND sequence check after that await, a rep who closes and switches company mid
    // refetch gets the previous company's brand-new contact selected underneath them — then fails the
    // server's company-membership check on create.
    let resolveRefetch: (v?: unknown) => void = () => {};
    const refetch = vi.fn(() => new Promise((resolve) => { resolveRefetch = resolve; }));
    mocks.useCompanyContacts.mockReturnValue({ contacts: [], loading: false, error: null, refetch });
    mocks.createContact.mockResolvedValue({ contact: { id: "contact-9", firstName: "Ada", lastName: "Lowe" } });
    const onChange = vi.fn();
    render({ onChange });

    act(() => container.querySelector<HTMLButtonElement>("[data-testid='poc-add-button']")!.click());
    setFieldValue("poc-first-name", "Ada");
    setFieldValue("poc-last-name", "Lowe");
    await act(async () => {
      document.querySelector<HTMLButtonElement>("[data-testid='poc-save']")!.click();
    });

    // The rep closes the dialog while the refetch is still in flight — via the DialogContent's OWN close
    // button, which unlike Cancel and Save is not disabled by `saving`, so this really is reachable.
    const builtInClose = document.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]');
    expect(builtInClose).not.toBeNull();
    act(() => {
      builtInClose!.click();
    });
    await act(async () => {
      resolveRefetch();
    });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("can still name a contact it created when the refetch that should return it fails", async () => {
    // A refetch that resolves without returning the new contact — the shape a failed or lagging refetch
    // leaves behind, since useCompanyContacts catches its own error and clears `contacts`. Without the
    // local fallback the trigger reads "Select a point of contact" while the parent holds the id: an
    // invisible selection on the one field whose job is to say who to call. (A genuine network failure
    // also sets `error`, which routes to the retry banner; this pins the naming, not the banner.)
    const refetch = vi.fn(async () => {});
    mocks.useCompanyContacts.mockReturnValue({ contacts: [], loading: false, error: null, refetch });
    mocks.createContact.mockResolvedValue({
      contact: { id: "contact-9", firstName: "Ada", lastName: "Lowe", email: null, phone: null, jobTitle: null, category: "client" },
    });
    const onChange = vi.fn();
    render({ onChange });

    act(() => container.querySelector<HTMLButtonElement>("[data-testid='poc-add-button']")!.click());
    setFieldValue("poc-first-name", "Ada");
    setFieldValue("poc-last-name", "Lowe");
    await act(async () => {
      document.querySelector<HTMLButtonElement>("[data-testid='poc-save']")!.click();
    });

    expect(onChange).toHaveBeenCalledWith("contact-9");
    // Re-render as the parent would, now holding the new id, with the refetch still returning nothing.
    render({ onChange, value: "contact-9" });
    expect(container.querySelector("[data-testid='poc-select']")?.textContent).toContain("Ada Lowe");
  });

  it("does not carry a contact created for one company into another company's list", async () => {
    const refetch = vi.fn(async () => {});
    mocks.useCompanyContacts.mockReturnValue({ contacts: [], loading: false, error: null, refetch });
    mocks.createContact.mockResolvedValue({
      contact: { id: "contact-9", firstName: "Ada", lastName: "Lowe", email: null, phone: null, jobTitle: null, category: "client" },
    });
    render({ companyId: "company-1" });

    act(() => container.querySelector<HTMLButtonElement>("[data-testid='poc-add-button']")!.click());
    setFieldValue("poc-first-name", "Ada");
    setFieldValue("poc-last-name", "Lowe");
    await act(async () => {
      document.querySelector<HTMLButtonElement>("[data-testid='poc-save']")!.click();
    });

    // Switching company must not keep offering a contact the server would reject for it. Asserted with the
    // id SELECTED, because the trigger renders only the selected item's label — the closed dropdown is not
    // mounted, so a `value: ""` assertion here could never see a leaked contact and would prove nothing.
    render({ companyId: "company-2", value: "contact-9" });
    expect(container.querySelector("[data-testid='poc-select']")?.textContent).not.toContain("Ada Lowe");
    expect(container.querySelector("[data-testid='poc-select']")?.textContent).toContain(
      "Select a point of contact"
    );
  });

  it("keeps a contact created while the dialog was dismissed mid-create, without selecting it", async () => {
    // The dialog can be closed while createContact is still in flight, and the server creates the contact
    // anyway. Dropping it here left the picker stale — a rep who reopened and retyped the same person hit
    // dedup against a list missing them, which classifies the match as CROSS-company, withholds "Use this
    // contact", and walks them into force-creating the duplicate. Cache and refresh regardless; only the
    // SELECTION is session-scoped.
    let resolveCreate: (v: unknown) => void = () => {};
    mocks.useCompanyContacts.mockReturnValue({ contacts: [], loading: false, error: null, refetch: vi.fn(async () => {}) });
    mocks.createContact.mockImplementation(() => new Promise((resolve) => { resolveCreate = resolve; }));
    const onChange = vi.fn();
    render({ onChange });

    act(() => container.querySelector<HTMLButtonElement>("[data-testid='poc-add-button']")!.click());
    setFieldValue("poc-first-name", "Ada");
    setFieldValue("poc-last-name", "Lowe");
    act(() => {
      document.querySelector<HTMLButtonElement>("[data-testid='poc-save']")!.click();
    });

    // Dismissed via the dialog's own close button while the create is still pending.
    act(() => {
      document.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')!.click();
    });
    await act(async () => {
      resolveCreate({ contact: { id: "contact-9", firstName: "Ada", lastName: "Lowe", email: null, phone: null, jobTitle: null, category: "client" } });
    });

    // Not selected — the rep had moved on.
    expect(onChange).not.toHaveBeenCalled();
    // But known: re-rendering with it selected must be able to name it, proving it is in the scoped list.
    render({ onChange, value: "contact-9" });
    expect(container.querySelector("[data-testid='poc-select']")?.textContent).toContain("Ada Lowe");
  });

  it("does not refetch on behalf of a dismissed save, which would clobber the current company", async () => {
    // `refetch` is captured for the company the dialog was opened under, and useCompanyContacts shares one
    // request counter across renders — so a late call from a dismissed save supersedes the CURRENT
    // company's in-flight request and can repopulate the picker with the old company's contacts.
    let resolveCreate: (v: unknown) => void = () => {};
    const refetch = vi.fn(async () => {});
    mocks.useCompanyContacts.mockReturnValue({ contacts: [], loading: false, error: null, refetch });
    mocks.createContact.mockImplementation(() => new Promise((resolve) => { resolveCreate = resolve; }));
    render({ onChange: vi.fn() });

    act(() => container.querySelector<HTMLButtonElement>("[data-testid='poc-add-button']")!.click());
    setFieldValue("poc-first-name", "Ada");
    setFieldValue("poc-last-name", "Lowe");
    act(() => {
      document.querySelector<HTMLButtonElement>("[data-testid='poc-save']")!.click();
    });
    act(() => {
      document.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')!.click();
    });
    await act(async () => {
      resolveCreate({ contact: { id: "contact-9", firstName: "Ada", lastName: "Lowe", email: null, phone: null, jobTitle: null, category: "client" } });
    });

    expect(refetch).not.toHaveBeenCalled();
  });

  it("drops a held contact the loaded company list cannot account for", async () => {
    // A prefilled ?primaryContactId that has since been archived or reassigned is not in the list, so the
    // trigger falls back to "Select a point of contact" while the parent still holds the value — its
    // required-field check passes and it submits a contact the rep cannot see.
    const onChange = vi.fn();
    mocks.useCompanyContacts.mockReturnValue({
      contacts: [{ id: "contact-1", firstName: "Dana", lastName: "Reyes", email: null, phone: null, jobTitle: null, category: "client" }],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    await act(async () => {
      render({ onChange, value: "contact-gone" });
    });

    expect(onChange).toHaveBeenCalledWith("");
  });

  it("keeps a held contact while the company list is still loading or errored", async () => {
    // The mirror of the test above: an empty list mid-load, or after a failure, says NOTHING about whether
    // the held contact is valid. Clearing there would discard a perfectly good prefill on a slow network.
    const onChange = vi.fn();
    mocks.useCompanyContacts.mockReturnValue({ contacts: [], loading: true, error: null, refetch: vi.fn() });
    await act(async () => {
      render({ onChange, value: "contact-7" });
    });
    expect(onChange).not.toHaveBeenCalled();

    mocks.useCompanyContacts.mockReturnValue({ contacts: [], loading: false, error: "boom", refetch: vi.fn() });
    await act(async () => {
      render({ onChange, value: "contact-7" });
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("will not open the add dialog while the company's contacts are unavailable", () => {
    // Membership is decided by looking a suggestion up in `contacts` (a suggestion carries no companyId),
    // so an empty list — errored OR still loading — would brand a contact that genuinely belongs to this
    // company as "different company", withhold "Use this contact", and walk the rep into force-creating
    // the very duplicate this dialog exists to prevent.
    mocks.useCompanyContacts.mockReturnValue({ contacts: [], loading: false, error: "boom", refetch: vi.fn() });
    render();
    expect(container.querySelector<HTMLButtonElement>("[data-testid='poc-add-button']")?.disabled).toBe(true);

    mocks.useCompanyContacts.mockReturnValue({ contacts: [], loading: true, error: null, refetch: vi.fn() });
    render();
    expect(container.querySelector<HTMLButtonElement>("[data-testid='poc-add-button']")?.disabled).toBe(true);
  });
});
