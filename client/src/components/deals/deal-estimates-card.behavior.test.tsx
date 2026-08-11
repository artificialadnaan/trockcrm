/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DealEstimatesCard } from "./deal-estimates-card";

const mocks = vi.hoisted(() => ({
  addDealChangeOrder: vi.fn(),
  updateDealChangeOrder: vi.fn(),
  deleteDealChangeOrder: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  onChanged: vi.fn(),
}));

vi.mock("@/hooks/use-deals", () => ({
  addDealChangeOrder: mocks.addDealChangeOrder,
  updateDealChangeOrder: mocks.updateDealChangeOrder,
  deleteDealChangeOrder: mocks.deleteDealChangeOrder,
}));

vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));

// Render the dialog inline when open so we can exercise the form without Radix's portal/pointer setup.
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const baseDeal = {
  id: "deal-1",
  ddEstimate: "10000",
  bidEstimate: "20000",
  awardedAmount: "100000",
  changeOrderTotal: "5000", // Procore-synced approved COs
} as any;

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function clickButtonByText(container: HTMLElement, text: string) {
  const btn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes(text));
  if (!btn) throw new Error(`button "${text}" not found`);
  act(() => {
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

let roots: Root[] = [];
let containers: HTMLElement[] = [];

function render(props: Parameters<typeof DealEstimatesCard>[0]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<DealEstimatesCard {...props} />);
  });
  roots.push(root);
  containers.push(container);
  return container;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.addDealChangeOrder.mockResolvedValue({ changeOrder: { id: "co-new" } });
  mocks.updateDealChangeOrder.mockResolvedValue({ changeOrder: { id: "co-1" } });
  mocks.deleteDealChangeOrder.mockResolvedValue({ success: true });
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  for (const c of containers) c.remove();
  roots = [];
  containers = [];
});

const crmChangeOrders = [
  { id: "co-1", dealId: "deal-1", signedDate: "2026-05-01", amount: "2000", description: "punch list", createdBy: null, updatedBy: null, createdAt: "", updatedAt: "" },
  { id: "co-2", dealId: "deal-1", signedDate: "2026-01-01", amount: "3000", description: null, createdBy: null, updatedBy: null, createdAt: "", updatedAt: "" },
];

describe("DealEstimatesCard change orders", () => {
  it("shows the combined change-order total (Procore + CRM) and the current contract value", () => {
    const container = render({
      deal: baseDeal,
      changeOrders: crmChangeOrders,
      changeOrderTotal: "5000",
    });
    // Procore 5000 + CRM 5000 = 10000
    expect(container.querySelector('[data-testid="change-order-total"]')?.textContent).toContain("$10,000");
    // CCV = awarded 100000 + Procore 5000 + CRM 5000 = 110000
    expect(container.textContent).toContain("$110,000");
  });

  it("counts CO value exactly once on top of the base (disjoint-sum: CCV = awarded + COs)", () => {
    // No Procore COs; awarded 100000 is the CO-free base; CRM COs sum to 4500.
    const container = render({
      deal: { id: "deal-1", ddEstimate: "0", bidEstimate: "0", awardedAmount: "100000", changeOrderTotal: "0" } as any,
      changeOrders: [
        { id: "a", dealId: "deal-1", signedDate: "2026-03-01", amount: "3000", description: null, createdBy: null, updatedBy: null, createdAt: "", updatedAt: "" },
        { id: "b", dealId: "deal-1", signedDate: "2026-04-01", amount: "1500", description: null, createdBy: null, updatedBy: null, createdAt: "", updatedAt: "" },
      ],
      changeOrderTotal: "4500",
    });
    // Change Orders line shows ONLY the COs (4500), not folded into the base.
    expect(container.querySelector('[data-testid="change-order-total"]')?.textContent).toContain("$4,500");
    // CCV = base 100000 + COs 4500 = 104500 (each dollar once).
    expect(container.textContent).toContain("$104,500");
  });

  it("renders each CRM change order row", () => {
    const container = render({ deal: baseDeal, changeOrders: crmChangeOrders, changeOrderTotal: "5000" });
    const rows = container.querySelectorAll('[data-testid="change-order-row"]');
    expect(rows.length).toBe(2);
    expect(container.textContent).toContain("2026-05-01");
    expect(container.textContent).toContain("punch list");
  });

  it("shows the Add / edit / remove controls only when the viewer can manage (and a refresh is wired)", () => {
    const adminContainer = render({ deal: baseDeal, changeOrders: crmChangeOrders, changeOrderTotal: "5000", canManage: true, onChanged: mocks.onChanged });
    expect(Array.from(adminContainer.querySelectorAll("button")).some((b) => b.textContent?.includes("Add Change Order"))).toBe(true);
    expect(adminContainer.querySelector('[aria-label="Edit change order"]')).not.toBeNull();
    expect(adminContainer.querySelector('[aria-label="Remove change order"]')).not.toBeNull();

    const repContainer = render({ deal: baseDeal, changeOrders: crmChangeOrders, changeOrderTotal: "5000", canManage: false, onChanged: mocks.onChanged });
    expect(Array.from(repContainer.querySelectorAll("button")).some((b) => b.textContent?.includes("Add Change Order"))).toBe(false);
    expect(repContainer.querySelector('[aria-label="Edit change order"]')).toBeNull();
    expect(repContainer.querySelector('[aria-label="Remove change order"]')).toBeNull();
  });

  it("hides mutation controls when canManage but no onChanged refresh is wired (avoids stale UI)", () => {
    const container = render({ deal: baseDeal, changeOrders: crmChangeOrders, changeOrderTotal: "5000", canManage: true });
    expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent?.includes("Add Change Order"))).toBe(false);
    expect(container.querySelector('[aria-label="Edit change order"]')).toBeNull();
    // The totals/list still render read-only.
    expect(container.querySelectorAll('[data-testid="change-order-row"]').length).toBe(2);
  });

  it("adds a change order through the dialog and calls onChanged", async () => {
    const container = render({
      deal: baseDeal,
      changeOrders: [],
      changeOrderTotal: "0",
      canManage: true,
      onChanged: mocks.onChanged,
    });
    expect(container.querySelector('[data-testid="dialog"]')).toBeNull();

    clickButtonByText(container, "Add Change Order");
    expect(container.querySelector('[data-testid="dialog"]')).not.toBeNull();

    act(() => {
      setValue(container.querySelector<HTMLInputElement>("#co-signed-date")!, "2026-03-15");
      setValue(container.querySelector<HTMLInputElement>("#co-amount")!, "1500");
    });

    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(mocks.addDealChangeOrder).toHaveBeenCalledWith("deal-1", {
      signedDate: "2026-03-15",
      amount: "1500",
      description: null,
    });
    expect(mocks.onChanged).toHaveBeenCalled();
  });

  it("blocks a zero amount in the dialog without calling the API (server's wording)", async () => {
    const container = render({ deal: baseDeal, changeOrders: [], changeOrderTotal: "0", canManage: true, onChanged: mocks.onChanged });
    clickButtonByText(container, "Add Change Order");
    act(() => {
      setValue(container.querySelector<HTMLInputElement>("#co-signed-date")!, "2026-03-15");
      setValue(container.querySelector<HTMLInputElement>("#co-amount")!, "0");
    });
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(mocks.addDealChangeOrder).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Change order amount cannot be 0.");
  });

  it("rejects an extra-precision amount client-side (mirrors the server), without calling the API", async () => {
    const container = render({ deal: baseDeal, changeOrders: [], changeOrderTotal: "0", canManage: true, onChanged: mocks.onChanged });
    clickButtonByText(container, "Add Change Order");
    act(() => {
      setValue(container.querySelector<HTMLInputElement>("#co-signed-date")!, "2026-03-15");
      setValue(container.querySelector<HTMLInputElement>("#co-amount")!, "0.005");
    });
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(mocks.addDealChangeOrder).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Change order amount must be a number with at most 2 decimals");
  });

  it("edits an existing change order through the dialog (prefilled) and PATCHes it", async () => {
    const container = render({
      deal: baseDeal,
      changeOrders: crmChangeOrders,
      changeOrderTotal: "5000",
      canManage: true,
      onChanged: mocks.onChanged,
    });

    act(() => {
      container.querySelector<HTMLButtonElement>('[aria-label="Edit change order"]')!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    // Prefilled from the first row (co-1)
    expect(container.querySelector<HTMLInputElement>("#co-amount")!.value).toBe("2000");

    act(() => {
      setValue(container.querySelector<HTMLInputElement>("#co-amount")!, "2500");
    });
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(mocks.updateDealChangeOrder).toHaveBeenCalledWith("deal-1", "co-1", {
      signedDate: "2026-05-01",
      amount: "2500",
      description: "punch list",
    });
    expect(mocks.onChanged).toHaveBeenCalled();
  });

  it("removes a change order after confirmation", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const container = render({
      deal: baseDeal,
      changeOrders: crmChangeOrders,
      changeOrderTotal: "5000",
      canManage: true,
      onChanged: mocks.onChanged,
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Remove change order"]')!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });

    expect(mocks.deleteDealChangeOrder).toHaveBeenCalledWith("deal-1", "co-1");
    expect(mocks.onChanged).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Deductive change orders (a NEGATIVE amount reduces the parent's contract value).
// ---------------------------------------------------------------------------

function makeCo(overrides: Partial<{ id: string; signedDate: string; amount: string; description: string | null }> = {}) {
  return {
    id: "co-1",
    dealId: "deal-1",
    signedDate: "2026-05-01",
    amount: "2000",
    description: null,
    createdBy: null,
    updatedBy: null,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

/** Open the Add dialog, fill the two required fields, submit. */
async function submitNewChangeOrder(container: HTMLElement, amount: string, signedDate = "2026-03-15") {
  clickButtonByText(container, "Add Change Order");
  act(() => {
    setValue(container.querySelector<HTMLInputElement>("#co-signed-date")!, signedDate);
    setValue(container.querySelector<HTMLInputElement>("#co-amount")!, amount);
  });
  await act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("DealEstimatesCard — deductive change orders", () => {
  it("submits a negative amount verbatim (deductive CO)", async () => {
    const container = render({
      deal: baseDeal, // awarded 100000 + Procore 5000 — a -2500 CO leaves CCV well above zero
      changeOrders: [],
      changeOrderTotal: "0",
      canManage: true,
      onChanged: mocks.onChanged,
    });

    await submitNewChangeOrder(container, "-2500");

    expect(mocks.addDealChangeOrder).toHaveBeenCalledWith("deal-1", {
      signedDate: "2026-03-15",
      amount: "-2500",
      description: null,
    });
    expect(mocks.onChanged).toHaveBeenCalled();
  });

  it("does not set min on the amount input (the browser would block a negative before the handler runs)", () => {
    const container = render({ deal: baseDeal, changeOrders: [], changeOrderTotal: "0", canManage: true, onChanged: mocks.onChanged });
    clickButtonByText(container, "Add Change Order");
    const input = container.querySelector<HTMLInputElement>("#co-amount")!;
    expect(input.getAttribute("min")).toBeNull();
    expect(input.getAttribute("step")).toBe("0.01");
  });

  it("rejects -0.00 with the server's zero wording, without calling the API", async () => {
    const container = render({ deal: baseDeal, changeOrders: [], changeOrderTotal: "0", canManage: true, onChanged: mocks.onChanged });
    await submitNewChangeOrder(container, "-0.00");
    expect(mocks.addDealChangeOrder).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Change order amount cannot be 0.");
  });

  it("rejects a magnitude over the NUMERIC(14,2) ceiling with the server's pattern wording", async () => {
    const container = render({ deal: baseDeal, changeOrders: [], changeOrderTotal: "0", canManage: true, onChanged: mocks.onChanged });
    await submitNewChangeOrder(container, "-1000000000000"); // 13 integer digits
    expect(mocks.addDealChangeOrder).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Change order amount must be a number with at most 2 decimals");
  });

  it("asks for confirmation when the CO would take the Current Contract Value below $0, and blocks when declined", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const container = render({
      deal: { id: "deal-1", ddEstimate: "0", bidEstimate: "0", awardedAmount: "1000", changeOrderTotal: "0" } as any,
      changeOrders: [],
      changeOrderTotal: "0",
      canManage: true,
      onChanged: mocks.onChanged,
    });

    await submitNewChangeOrder(container, "-5000"); // 1000 - 5000 = -4000

    expect(confirmSpy).toHaveBeenCalled();
    expect(mocks.addDealChangeOrder).not.toHaveBeenCalled();
    expect(mocks.onChanged).not.toHaveBeenCalled();
    // The dialog stays open so the user can correct the amount.
    expect(container.querySelector('[data-testid="dialog"]')).not.toBeNull();
    confirmSpy.mockRestore();
  });

  it("saves the below-zero change order when the confirmation is accepted (advisory guard, not enforced)", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const container = render({
      deal: { id: "deal-1", ddEstimate: "0", bidEstimate: "0", awardedAmount: "1000", changeOrderTotal: "0" } as any,
      changeOrders: [],
      changeOrderTotal: "0",
      canManage: true,
      onChanged: mocks.onChanged,
    });

    await submitNewChangeOrder(container, "-5000");

    expect(confirmSpy).toHaveBeenCalled();
    expect(mocks.addDealChangeOrder).toHaveBeenCalledWith("deal-1", {
      signedDate: "2026-03-15",
      amount: "-5000",
      description: null,
    });
    expect(mocks.onChanged).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("does not confirm for a positive change order (existing flow untouched)", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const container = render({
      deal: { id: "deal-1", ddEstimate: "0", bidEstimate: "0", awardedAmount: "1000", changeOrderTotal: "0" } as any,
      changeOrders: [],
      changeOrderTotal: "0",
      canManage: true,
      onChanged: mocks.onChanged,
    });

    await submitNewChangeOrder(container, "500");

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(mocks.addDealChangeOrder).toHaveBeenCalledWith("deal-1", {
      signedDate: "2026-03-15",
      amount: "500",
      description: null,
    });
    confirmSpy.mockRestore();
  });

  it("excludes the edited CO's own amount from the below-zero baseline (no double-count)", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    // Base 1000 with an existing -800 CO ⇒ CCV 200. Re-editing that CO to -900 leaves CCV at
    // 1000 - 900 = 100, still above zero — only a baseline that double-counted the old -800 would warn.
    const container = render({
      deal: { id: "deal-1", ddEstimate: "0", bidEstimate: "0", awardedAmount: "1000", changeOrderTotal: "0" } as any,
      changeOrders: [makeCo({ amount: "-800" })] as any,
      changeOrderTotal: "-800",
      canManage: true,
      onChanged: mocks.onChanged,
    });

    act(() => {
      container.querySelector<HTMLButtonElement>('[aria-label="Edit change order"]')!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    act(() => {
      setValue(container.querySelector<HTMLInputElement>("#co-amount")!, "-900");
    });
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(mocks.updateDealChangeOrder).toHaveBeenCalledWith("deal-1", "co-1", {
      signedDate: "2026-05-01",
      amount: "-900",
      description: null,
    });
    confirmSpy.mockRestore();
  });

  it("still warns when the EDITED amount itself takes the contract value below zero", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const container = render({
      deal: { id: "deal-1", ddEstimate: "0", bidEstimate: "0", awardedAmount: "1000", changeOrderTotal: "0" } as any,
      changeOrders: [makeCo({ amount: "-800" })] as any,
      changeOrderTotal: "-800",
      canManage: true,
      onChanged: mocks.onChanged,
    });

    act(() => {
      container.querySelector<HTMLButtonElement>('[aria-label="Edit change order"]')!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    act(() => {
      setValue(container.querySelector<HTMLInputElement>("#co-amount")!, "-1200"); // 1000 - 1200 = -200
    });
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(confirmSpy).toHaveBeenCalled();
    expect(mocks.updateDealChangeOrder).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("does not warn when the CO lands the contract value exactly at $0 (float noise)", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    // 2.9 + 0.7 - 3.6 === -4.44e-16 in IEEE-754: an exactly break-even CO must not read as below zero.
    const container = render({
      deal: { id: "deal-1", ddEstimate: "0", bidEstimate: "0", awardedAmount: "2.90", changeOrderTotal: "0.70" } as any,
      changeOrders: [],
      changeOrderTotal: "0",
      canManage: true,
      onChanged: mocks.onChanged,
    });

    await submitNewChangeOrder(container, "-3.60");

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(mocks.addDealChangeOrder).toHaveBeenCalledWith("deal-1", {
      signedDate: "2026-03-15",
      amount: "-3.60",
      description: null,
    });
    confirmSpy.mockRestore();
  });

  it("clears a stale validation error before the below-zero confirm, so declining leaves no wrong message", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const container = render({
      deal: { id: "deal-1", ddEstimate: "0", bidEstimate: "0", awardedAmount: "1000", changeOrderTotal: "0" } as any,
      changeOrders: [],
      changeOrderTotal: "0",
      canManage: true,
      onChanged: mocks.onChanged,
    });

    await submitNewChangeOrder(container, "0"); // rejected — error on screen
    expect(container.textContent).toContain("Change order amount cannot be 0.");

    // Correct it to a valid (but below-zero) amount and decline the warning.
    act(() => {
      setValue(container.querySelector<HTMLInputElement>("#co-amount")!, "-5000");
    });
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(confirmSpy).toHaveBeenCalled();
    expect(mocks.addDealChangeOrder).not.toHaveBeenCalled();
    // The amount is now valid, so the old rejection must be gone.
    expect(container.textContent).not.toContain("Change order amount cannot be 0.");
    confirmSpy.mockRestore();
  });

  it("does not paint an exactly break-even Current Contract Value red (float noise)", () => {
    // 2.90 + 0.70 - 3.60 === -4.44e-16 — `< 0` on the raw sum, but the contract value is $0.
    const container = render({
      deal: { id: "deal-1", ddEstimate: "0", bidEstimate: "0", awardedAmount: "2.90", changeOrderTotal: "0.70" } as any,
      changeOrders: [makeCo({ amount: "-3.60" })] as any,
      changeOrderTotal: "-3.60",
    });

    const ccv = container.querySelector('[data-testid="current-contract-value"]');
    expect(ccv?.getAttribute("class")).not.toContain("text-red-600");
    expect(ccv?.getAttribute("class")).toContain("text-green-600");
    // ...and no phantom minus sign on the zero either.
    expect(ccv?.textContent).toBe("$0");
  });

  it("does not paint an exactly break-even combined change-order total red (float noise)", () => {
    // Procore +2.90 against CRM COs of +0.70 and -3.60. With no server total the card sums the rows
    // itself (0.70 + -3.60 === -2.9000000000000004), so the combined total is -4.44e-16: $0, not a
    // deduction.
    const container = render({
      deal: { id: "deal-1", ddEstimate: "0", bidEstimate: "0", awardedAmount: "1000", changeOrderTotal: "2.90" } as any,
      changeOrders: [makeCo({ id: "co-a", amount: "0.70" }), makeCo({ id: "co-b", amount: "-3.60" })] as any,
    });

    const total = container.querySelector('[data-testid="change-order-total"]');
    expect(total?.getAttribute("class")).not.toContain("text-red-600");
    expect(total?.textContent).toBe("$0");
  });

  it("tells the user a negative amount records a deductive change order", () => {
    const container = render({ deal: baseDeal, changeOrders: [], changeOrderTotal: "0", canManage: true, onChanged: mocks.onChanged });
    clickButtonByText(container, "Add Change Order");
    expect(container.textContent).toContain("deductive change order");
    // The old copy claimed the amount only ADDS to the contract value.
    expect(container.textContent).not.toContain("adds to the Current Contract Value");
  });

  it("marks a deductive row so it reads as a deduction, not an addition", () => {
    const container = render({
      deal: baseDeal,
      changeOrders: [makeCo({ id: "co-plus", amount: "2000" }), makeCo({ id: "co-minus", amount: "-2000" })] as any,
      changeOrderTotal: "0",
    });

    const rows = Array.from(container.querySelectorAll('[data-testid="change-order-row"]'));
    expect(rows.length).toBe(2);
    const amounts = rows.map((r) => r.querySelector('[data-testid="change-order-amount"]'));
    expect(amounts[0]?.textContent).toBe("$2,000");
    expect(amounts[1]?.textContent).toBe("-$2,000");
    // The minus sign alone is easy to miss at a glance — the deductive row also carries the card's
    // existing red treatment, and the additive row must NOT.
    expect(amounts[1]?.getAttribute("class")).toContain("text-red-600");
    expect(amounts[0]?.getAttribute("class")).not.toContain("text-red-600");
  });

  it("does not paint a below-zero Current Contract Value in the positive (green) treatment", () => {
    const container = render({
      deal: { id: "deal-1", ddEstimate: "0", bidEstimate: "0", awardedAmount: "1000", changeOrderTotal: "0" } as any,
      changeOrders: [makeCo({ amount: "-4000" })] as any,
      changeOrderTotal: "-4000",
    });

    const ccv = container.querySelector('[data-testid="current-contract-value"]');
    expect(ccv?.textContent).toBe("-$3,000");
    expect(ccv?.getAttribute("class")).not.toContain("text-green-600");
    expect(ccv?.getAttribute("class")).toContain("text-red-600");
  });
});
