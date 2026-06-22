/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MoveCloseDateDialog } from "./move-close-date-dialog";

const mocks = vi.hoisted(() => ({
  updateDeal: vi.fn(),
  createActivity: vi.fn(),
  onSaved: vi.fn(),
  onOpenChange: vi.fn(),
}));

vi.mock("@/hooks/use-deals", () => ({ updateDeal: mocks.updateDeal }));
vi.mock("@/hooks/use-activities", () => ({ createActivity: mocks.createActivity }));
// Render the dialog inline when open so the form is exercisable without Radix's portal/pointer setup.
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

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(el, value);
  act(() => {
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function saveButton(c: HTMLElement): HTMLButtonElement {
  const btn = Array.from(c.querySelectorAll("button")).find((b) => b.textContent?.includes("Move close date"));
  if (!btn) throw new Error("save button not found");
  return btn as HTMLButtonElement;
}

let roots: Root[] = [];
let containers: HTMLElement[] = [];

function render(currentDate: string | null = null) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MoveCloseDateDialog
        open
        onOpenChange={mocks.onOpenChange}
        dealId="deal-1"
        currentDate={currentDate}
        onSaved={mocks.onSaved}
      />
    );
  });
  roots.push(root);
  containers.push(container);
  return container;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateDeal.mockResolvedValue({});
  mocks.createActivity.mockResolvedValue({});
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  for (const c of containers) c.remove();
  roots = [];
  containers = [];
});

describe("MoveCloseDateDialog", () => {
  it("keeps Save disabled until BOTH a date and a reason are provided", () => {
    const c = render();
    expect(saveButton(c).disabled).toBe(true);

    setValue(c.querySelector("#move-close-date") as HTMLInputElement, "2026-09-01");
    expect(saveButton(c).disabled).toBe(true); // reason still empty

    setValue(c.querySelector("#move-close-reason") as HTMLTextAreaElement, "  "); // whitespace-only doesn't count
    expect(saveButton(c).disabled).toBe(true);

    setValue(c.querySelector("#move-close-reason") as HTMLTextAreaElement, "Client pushed to Q4");
    expect(saveButton(c).disabled).toBe(false);
  });

  it("on save: moves the close date FIRST, then logs the reason as a note, then notifies + closes", async () => {
    const c = render();
    setValue(c.querySelector("#move-close-date") as HTMLInputElement, "2026-09-01");
    setValue(c.querySelector("#move-close-reason") as HTMLTextAreaElement, "Client pushed to Q4");

    await act(async () => {
      saveButton(c).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mocks.updateDeal).toHaveBeenCalledWith("deal-1", { expectedCloseDate: "2026-09-01" });
    expect(mocks.createActivity).toHaveBeenCalledWith(
      expect.objectContaining({ type: "note", body: "Client pushed to Q4", dealId: "deal-1" })
    );
    // the date write must precede the note (the date drives the SLA; the note is the audit layer)
    expect(mocks.updateDeal.mock.invocationCallOrder[0]).toBeLessThan(mocks.createActivity.mock.invocationCallOrder[0]);
    expect(mocks.onSaved).toHaveBeenCalled();
    expect(mocks.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("seeds the picker from the deal's current close date", () => {
    const c = render("2026-07-15");
    expect((c.querySelector("#move-close-date") as HTMLInputElement).value).toBe("2026-07-15");
  });
});
