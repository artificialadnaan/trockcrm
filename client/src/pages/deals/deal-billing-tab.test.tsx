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

const dealNoBilling = { id: "deal-1", billingContactId: null, billingContactName: null,
  billingContactEmail: null, billingContactPhone: null, billingContactCompany: null, billingContactTitle: null };
const dealWithBilling = { ...dealNoBilling, billingContactId: "c-9", billingContactName: "Jane Doe",
  billingContactEmail: "jane@acme.com", billingContactPhone: "555-1212", billingContactCompany: "Acme AP", billingContactTitle: "AP Lead" };

async function render(deal: unknown, onDealUpdated = vi.fn(), canEdit = true) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    root.render(<MemoryRouter><DealBillingTab deal={deal as any} onDealUpdated={onDealUpdated} canEdit={canEdit} /></MemoryRouter>);
  });
  await act(async () => { await Promise.resolve(); });
  return { container, onDealUpdated };
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
  });

  it("adding a new contact inline creates it then assigns it to the deal", async () => {
    mocks.apiMock.mockImplementation((url: string, opts?: { method?: string }) => {
      if (url.includes("/contacts") && opts?.method === "POST") return Promise.resolve({ contact: { id: "c-new" } });
      if (url.includes("/deals/deal-1")) return Promise.resolve({ deal: dealWithBilling });
      return Promise.resolve({ contacts: [] });
    });
    const onDealUpdated = vi.fn();
    const { container } = await render(dealNoBilling, onDealUpdated);
    const setValue = (el: HTMLInputElement, v: string) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const addBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Add new contact")) as HTMLButtonElement;
    await act(async () => { addBtn.click(); });
    await act(async () => { await Promise.resolve(); });
    const first = document.querySelector("input[name='firstName']") as HTMLInputElement;
    const last = document.querySelector("input[name='lastName']") as HTMLInputElement;
    await act(async () => { setValue(first, "Pat"); setValue(last, "Payer"); });
    const save = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Save")) as HTMLButtonElement;
    await act(async () => { save.click(); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    expect(mocks.apiMock).toHaveBeenCalledWith("/contacts", expect.objectContaining({ method: "POST" }));
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
    expect(container.textContent).toContain("Signed contract");  // section heading
    expect(container.textContent).toContain("Signed Contract");  // the existing file
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
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "jane");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
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
    // ...but there is NO search input, NO add button, NO upload zone — and a read-only note.
    expect(container.querySelector("input")).toBeNull();
    expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent?.includes("Add new contact"))).toBe(false);
    expect(container.querySelector("[data-testid='upload-zone']")).toBeNull();
    expect(container.textContent).toContain("Only the assigned rep can edit billing");
  });

  it("surfaces a possible-duplicate suggestion instead of silently creating a duplicate contact", async () => {
    let createCalls = 0;
    mocks.apiMock.mockImplementation((url: string, opts?: { method?: string; json?: { skipDedupCheck?: boolean } }) => {
      if (url === "/contacts" && opts?.method === "POST") {
        createCalls += 1;
        // First (dedup-enabled) attempt returns a look-alike; no contact is created.
        if (!opts?.json?.skipDedupCheck) {
          return Promise.resolve({ contact: null, dedupWarning: true, suggestions: [{ id: "dup-1", firstName: "Pat", lastName: "Payer", email: null, companyName: "Acme", matchReason: "same name" }] });
        }
        return Promise.resolve({ contact: { id: "c-forced" } });
      }
      if (url.includes("/deals/deal-1")) return Promise.resolve({ deal: dealWithBilling });
      return Promise.resolve({ contacts: [] });
    });
    const onDealUpdated = vi.fn();
    const { container } = await render(dealNoBilling, onDealUpdated);
    const setValue = (el: HTMLInputElement, v: string) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
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
    expect(document.body.textContent).toContain("Pat Payer");        // the suggestion
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
});
