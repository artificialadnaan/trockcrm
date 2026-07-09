// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DealBillingTab } from "./deal-billing-tab";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: mocks.apiMock }));

const dealNoBilling = { id: "deal-1", billingContactId: null, billingContactName: null,
  billingContactEmail: null, billingContactPhone: null, billingContactCompany: null, billingContactTitle: null };
const dealWithBilling = { ...dealNoBilling, billingContactId: "c-9", billingContactName: "Jane Doe",
  billingContactEmail: "jane@acme.com", billingContactPhone: "555-1212", billingContactCompany: "Acme AP", billingContactTitle: "AP Lead" };

async function render(deal: unknown, onDealUpdated = vi.fn()) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    root.render(<MemoryRouter><DealBillingTab deal={deal as any} onDealUpdated={onDealUpdated} /></MemoryRouter>);
  });
  await act(async () => { await Promise.resolve(); });
  return { container, onDealUpdated };
}

describe("DealBillingTab", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    mocks.apiMock.mockReset();
    mocks.apiMock.mockResolvedValue({ contacts: [], deal: dealWithBilling });
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
});
