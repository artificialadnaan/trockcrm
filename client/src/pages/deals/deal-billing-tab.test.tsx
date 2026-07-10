// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DealBillingTab } from "./deal-billing-tab";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  apiMock: vi.fn(),
  filesMock: vi.fn((..._args: unknown[]): { files: Array<{ id: string; displayName: string; category: string; createdAt: string }>; loading: boolean; refetch: () => void } => ({ files: [], loading: false, refetch: vi.fn() })),
}));
vi.mock("@/lib/api", () => ({ api: mocks.apiMock }));
vi.mock("@/hooks/use-files", () => ({ useFiles: (...args: unknown[]) => mocks.filesMock(...args), uploadFile: vi.fn() }));
vi.mock("@/components/files/file-upload-zone", () => ({ FileUploadZone: () => <div data-testid="upload-zone">Upload signed contract</div> }));
vi.mock("@/components/companies/company-selector", () => ({ CompanySelector: () => <div data-testid="company-selector" /> }));

const dealNoBilling = { id: "deal-1", billingContactId: null, billingContactName: null,
  billingContactEmail: null, billingContactPhone: null, billingContactCompany: null, billingContactTitle: null,
  billingContactAddress: null, billingContactCity: null, billingContactState: null, billingContactZip: null };
const dealWithBilling = { ...dealNoBilling, billingContactId: "c-9", billingContactName: "Jane Doe",
  billingContactEmail: "jane@acme.com", billingContactPhone: "555-1212", billingContactCompany: "Acme AP", billingContactTitle: "AP Lead",
  billingContactAddress: "100 Billing Way", billingContactCity: "Dallas", billingContactState: "TX", billingContactZip: "75201" };

async function render(deal: unknown, onDealUpdated = vi.fn(), canEdit = true, officeId: string | null = null) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    root.render(<MemoryRouter><DealBillingTab deal={deal as any} onDealUpdated={onDealUpdated} canEdit={canEdit} officeId={officeId} /></MemoryRouter>);
  });
  await act(async () => { await Promise.resolve(); });
  return { container, onDealUpdated };
}

// Set an input's value through the native prototype setter + a bubbling input event — React 19's synthetic
// onChange does NOT fire from a plain `el.value = ...` assignment.
function setValue(el: HTMLInputElement, v: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("DealBillingTab", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    mocks.apiMock.mockReset();
    mocks.apiMock.mockResolvedValue({ contacts: [], deal: dealWithBilling });
    mocks.filesMock.mockReturnValue({ files: [], loading: false, refetch: vi.fn() });
  });

  it("shows an empty state prompting to assign a billing contact when none is set", async () => {
    const { container } = await render(dealNoBilling);
    expect(container.textContent).toContain("No billing contact");
  });

  it("shows the assigned billing contact's info when set", async () => {
    const { container } = await render(dealWithBilling);
    expect(container.textContent).toContain("Jane Doe");
    expect(container.textContent).toContain("jane@acme.com");
    expect(container.textContent).toContain("Acme AP");
    expect(container.textContent).toContain("100 Billing Way, Dallas, TX, 75201");
  });

  it("adding a new contact inline creates it then assigns it to the deal", async () => {
    mocks.apiMock.mockImplementation((url: string, opts?: { method?: string }) => {
      if (url.includes("/contacts") && opts?.method === "POST") return Promise.resolve({ contact: { id: "c-new" } });
      if (url.includes("/deals/deal-1")) return Promise.resolve({ deal: dealWithBilling });
      return Promise.resolve({ contacts: [] });
    });
    const onDealUpdated = vi.fn();
    const { container } = await render(dealNoBilling, onDealUpdated);
    const addBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Add new contact")) as HTMLButtonElement;
    await act(async () => { addBtn.click(); });
    await act(async () => { await Promise.resolve(); });
    // The Company field is now the CRM CompanySelector (search + inline add), not a free-text input.
    expect(document.querySelector("[data-testid='company-selector']")).toBeTruthy();
    const first = document.querySelector("input[name='firstName']") as HTMLInputElement;
    const last = document.querySelector("input[name='lastName']") as HTMLInputElement;
    const address = document.querySelector("input[name='address']") as HTMLInputElement;
    const city = document.querySelector("input[name='city']") as HTMLInputElement;
    const state = document.querySelector("input[name='state']") as HTMLInputElement;
    const zip = document.querySelector("input[name='zip']") as HTMLInputElement;
    await act(async () => {
      setValue(first, "Pat"); setValue(last, "Payer");
      setValue(address, "100 Billing Way"); setValue(city, "Dallas"); setValue(state, "tx"); setValue(zip, "75201");
    });
    const save = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Save")) as HTMLButtonElement;
    await act(async () => { save.click(); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    expect(mocks.apiMock).toHaveBeenCalledWith(
      "/contacts",
      expect.objectContaining({
        method: "POST",
        json: expect.objectContaining({ address: "100 Billing Way", city: "Dallas", state: "TX", zip: "75201" }),
      })
    );
    expect(mocks.apiMock).toHaveBeenCalledWith(
      expect.stringContaining("/deals/deal-1"),
      expect.objectContaining({ method: "PATCH", json: expect.objectContaining({ billingContactId: "c-new" }) }),
    );
    expect(onDealUpdated).toHaveBeenCalled();
  });

  it("renders the contract upload zone and lists an existing signed contract", async () => {
    mocks.filesMock.mockReturnValue({
      files: [{ id: "f1", displayName: "Signed Contract", category: "contract", createdAt: "2026-07-01T00:00:00Z" }],
      loading: false, refetch: vi.fn(),
    });
    const { container } = await render(dealWithBilling);
    expect(container.textContent).toContain("Contract");         // section heading (generic contract bucket)
    expect(container.textContent).toContain("Signed Contract");  // the existing file (mock displayName)
    expect(container.querySelector("[data-testid='upload-zone']")).toBeTruthy();
  });

  it("assigning a searched contact PATCHes the deal with billingContactId", async () => {
    mocks.apiMock.mockImplementation((url: string) =>
      url.includes("/contacts/search")
        ? Promise.resolve({ contacts: [{ id: "c-9", firstName: "Jane", lastName: "Doe", email: "jane@acme.com", companyName: "Acme AP", category: "client" }] })
        : Promise.resolve({ deal: dealWithBilling }),
    );
    const onDealUpdated = vi.fn();
    const { container } = await render(dealNoBilling, onDealUpdated);
    const input = container.querySelector("input") as HTMLInputElement;
    await act(async () => { setValue(input, "jane"); });
    await act(async () => { await Promise.resolve(); });
    const option = Array.from(document.querySelectorAll("button")).find((n) => n.textContent?.includes("Jane Doe")) as HTMLElement;
    await act(async () => { option.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(mocks.apiMock).toHaveBeenCalledWith(
      expect.stringContaining("/deals/deal-1"),
      expect.objectContaining({ method: "PATCH", json: expect.objectContaining({ billingContactId: expect.any(String) }) }),
    );
    expect(onDealUpdated).toHaveBeenCalled();
  });

  it("renders read-only (no edit controls) when the viewer cannot edit the deal", async () => {
    const { container } = await render(dealWithBilling, vi.fn(), false);
    // The contact card still shows...
    expect(container.textContent).toContain("Jane Doe");
    // ...but there are NO billing-contact edit controls (search / add) — just a read-only note. The CONTRACT
    // upload stays available (file uploads are collaborator-gated server-side, not owner-only) per Codex.
    expect(container.querySelector("input")).toBeNull();
    expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent?.includes("Add new contact"))).toBe(false);
    expect(container.querySelector("[data-testid='upload-zone']")).toBeTruthy();
    expect(container.textContent).toContain("Only the assigned rep can edit billing");
  });

  it("surfaces a possible-duplicate suggestion instead of silently creating a duplicate contact", async () => {
    let createCalls = 0;
    mocks.apiMock.mockImplementation((url: string, opts?: { method?: string; json?: { skipDedupCheck?: boolean } }) => {
      if (url === "/contacts" && opts?.method === "POST") {
        createCalls += 1;
        // First (dedup-enabled) attempt returns a look-alike; no contact is created.
        if (!opts?.json?.skipDedupCheck) {
          return Promise.resolve({ contact: null, dedupWarning: true, suggestions: [
            { id: "dup-1", firstName: "Pat", lastName: "Payer", email: null, companyName: "Acme", isActive: true, matchReason: "same name" },
            { id: "dup-2", firstName: "Pat", lastName: "Ghost", email: null, companyName: "Acme", isActive: false, matchReason: "same name" }, // inactive -> filtered out
          ] });
        }
        return Promise.resolve({ contact: { id: "c-forced" } });
      }
      if (url.includes("/deals/deal-1")) return Promise.resolve({ deal: dealWithBilling });
      return Promise.resolve({ contacts: [] });
    });
    const onDealUpdated = vi.fn();
    const { container } = await render(dealNoBilling, onDealUpdated);
    (Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Add new contact")) as HTMLButtonElement).click();
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      setValue(document.querySelector("input[name='firstName']") as HTMLInputElement, "Pat");
      setValue(document.querySelector("input[name='lastName']") as HTMLInputElement, "Payer");
    });
    // First Save runs WITH dedup -> surfaces the suggestion, does NOT assign anything yet.
    await act(async () => { (Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Save") as HTMLButtonElement).click(); });
    await act(async () => { await Promise.resolve(); });
    expect(createCalls).toBe(1);
    expect(document.body.textContent).toContain("Pat Payer");        // the ACTIVE suggestion
    expect(document.body.textContent).not.toContain("Pat Ghost");    // inactive suggestion filtered out (#6)
    expect(document.body.textContent).toContain("Create anyway");    // Save became "Create anyway"
    expect(onDealUpdated).not.toHaveBeenCalled();                    // nothing assigned on the dedup warning
    // Picking the suggestion assigns the EXISTING contact — no duplicate created.
    await act(async () => { (Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Pat Payer")) as HTMLButtonElement).click(); });
    await act(async () => { await Promise.resolve(); });
    expect(createCalls).toBe(1);                                     // still only the one (dedup) create call
    expect(mocks.apiMock).toHaveBeenCalledWith(
      expect.stringContaining("/deals/deal-1"),
      expect.objectContaining({ method: "PATCH", json: expect.objectContaining({ billingContactId: "dup-1" }) }),
    );
    expect(onDealUpdated).toHaveBeenCalled();
  });

  it("clears duplicate suggestions when a contact field is edited (no unreviewed force-create)", async () => {
    mocks.apiMock.mockImplementation((url: string, opts?: { method?: string; json?: { skipDedupCheck?: boolean } }) => {
      if (url === "/contacts" && opts?.method === "POST" && !opts?.json?.skipDedupCheck) {
        return Promise.resolve({ contact: null, dedupWarning: true, suggestions: [{ id: "dup-1", firstName: "Pat", lastName: "Payer", email: null, companyName: "Acme", isActive: true, matchReason: "same name" }] });
      }
      return Promise.resolve({ contacts: [] });
    });
    const { container } = await render(dealNoBilling);
    (Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Add new contact")) as HTMLButtonElement).click();
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      setValue(document.querySelector("input[name='firstName']") as HTMLInputElement, "Pat");
      setValue(document.querySelector("input[name='lastName']") as HTMLInputElement, "Payer");
    });
    await act(async () => { (Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Save") as HTMLButtonElement).click(); });
    await act(async () => { await Promise.resolve(); });
    expect(document.body.textContent).toContain("Create anyway");   // dedup warning is up
    // Editing a field must drop the stale suggestions so the next submit re-checks — no forced create of an unreviewed payload.
    await act(async () => { setValue(document.querySelector("input[name='firstName']") as HTMLInputElement, "Patrick"); });
    expect(document.body.textContent).not.toContain("Create anyway");
    expect(Array.from(document.querySelectorAll("button")).some((b) => b.textContent === "Save")).toBe(true);
  });

  it("sends billing writes to the LOADED office when viewing cross-office", async () => {
    mocks.apiMock.mockImplementation((url: string) =>
      url.includes("/contacts/search")
        ? Promise.resolve({ contacts: [{ id: "c-9", firstName: "Jane", lastName: "Doe", email: null, companyName: "Acme", category: "client" }] })
        : Promise.resolve({ deal: dealWithBilling }),
    );
    const { container } = await render(dealNoBilling, vi.fn(), true, "office-b");
    const input = container.querySelector("input") as HTMLInputElement;
    await act(async () => { setValue(input, "jane"); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { (Array.from(document.querySelectorAll("button")).find((n) => n.textContent?.includes("Jane Doe")) as HTMLElement).click(); });
    await act(async () => { await Promise.resolve(); });
    expect(mocks.apiMock).toHaveBeenCalledWith(
      expect.stringContaining("/deals/deal-1"),
      expect.objectContaining({ method: "PATCH", headers: expect.objectContaining({ "x-office-id": "office-b" }) }),
    );
  });

  it("ignores a stale contact-search response that resolves after a newer query (searchSeq guard)", async () => {
    let resolveOld: ((v: unknown) => void) | undefined;
    let resolveNew: ((v: unknown) => void) | undefined;
    mocks.apiMock.mockImplementation((url: string) => {
      if (url.includes("q=ann")) return new Promise((r) => { resolveOld = r; });
      if (url.includes("q=beth")) return new Promise((r) => { resolveNew = r; });
      return Promise.resolve({ deal: dealWithBilling });
    });
    const { container } = await render(dealNoBilling);
    const input = container.querySelector("input") as HTMLInputElement;
    await act(async () => { setValue(input, "ann"); });   // older query (still in flight)
    await act(async () => { setValue(input, "beth"); });  // newer query (still in flight)
    // Resolve the NEWER query first, then the OLDER one afterwards.
    await act(async () => { resolveNew?.({ contacts: [{ id: "beth-1", firstName: "Beth", lastName: "New", email: null, companyName: null, category: "client" }] }); await Promise.resolve(); });
    await act(async () => { resolveOld?.({ contacts: [{ id: "ann-1", firstName: "Ann", lastName: "Stale", email: null, companyName: null, category: "client" }] }); await Promise.resolve(); });
    // The stale older response must be dropped by the sequence guard; only the newer query's result renders.
    expect(container.textContent).toContain("Beth New");
    expect(container.textContent).not.toContain("Ann Stale");
  });
});
