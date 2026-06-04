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

  it("shows the Add / edit / remove controls only when the viewer can manage", () => {
    const adminContainer = render({ deal: baseDeal, changeOrders: crmChangeOrders, changeOrderTotal: "5000", canManage: true });
    expect(Array.from(adminContainer.querySelectorAll("button")).some((b) => b.textContent?.includes("Add Change Order"))).toBe(true);
    expect(adminContainer.querySelector('[aria-label="Edit change order"]')).not.toBeNull();
    expect(adminContainer.querySelector('[aria-label="Remove change order"]')).not.toBeNull();

    const repContainer = render({ deal: baseDeal, changeOrders: crmChangeOrders, changeOrderTotal: "5000", canManage: false });
    expect(Array.from(repContainer.querySelectorAll("button")).some((b) => b.textContent?.includes("Add Change Order"))).toBe(false);
    expect(repContainer.querySelector('[aria-label="Edit change order"]')).toBeNull();
    expect(repContainer.querySelector('[aria-label="Remove change order"]')).toBeNull();
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

  it("blocks a non-positive amount in the dialog without calling the API", async () => {
    const container = render({ deal: baseDeal, changeOrders: [], changeOrderTotal: "0", canManage: true });
    clickButtonByText(container, "Add Change Order");
    act(() => {
      setValue(container.querySelector<HTMLInputElement>("#co-signed-date")!, "2026-03-15");
      setValue(container.querySelector<HTMLInputElement>("#co-amount")!, "0");
    });
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(mocks.addDealChangeOrder).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Amount must be a positive number");
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
