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

// A clearly-future date (90d out), computed so the test never ages into the past-date guard.
const FUTURE = (() => {
  const d = new Date();
  d.setDate(d.getDate() + 90);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
})();

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

    setValue(c.querySelector("#move-close-date") as HTMLInputElement, FUTURE);
    expect(saveButton(c).disabled).toBe(true); // reason still empty

    setValue(c.querySelector("#move-close-reason") as HTMLTextAreaElement, "  "); // whitespace-only doesn't count
    expect(saveButton(c).disabled).toBe(true);

    setValue(c.querySelector("#move-close-reason") as HTMLTextAreaElement, "Client pushed to Q4");
    expect(saveButton(c).disabled).toBe(false);
  });

  it("blocks a PAST close date (a past target would not postpone the SLA)", () => {
    const c = render();
    setValue(c.querySelector("#move-close-date") as HTMLInputElement, "2020-01-01");
    setValue(c.querySelector("#move-close-reason") as HTMLTextAreaElement, "stale date");
    expect(saveButton(c).disabled).toBe(true);
    expect(c.textContent).toContain("won't postpone the SLA");
  });

  it("on save: moves the close date FIRST, then logs the reason as a note, then notifies + closes", async () => {
    const c = render();
    setValue(c.querySelector("#move-close-date") as HTMLInputElement, FUTURE);
    setValue(c.querySelector("#move-close-reason") as HTMLTextAreaElement, "Client pushed to Q4");

    await act(async () => {
      saveButton(c).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mocks.updateDeal).toHaveBeenCalledWith("deal-1", { expectedCloseDate: FUTURE });
    expect(mocks.createActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "note",
        // body carries BOTH the moved-to date (the feed shows body, not subject) and the reason
        body: expect.stringContaining("Client pushed to Q4"),
        dealId: "deal-1",
      })
    );
    const noteBody = mocks.createActivity.mock.calls[0][0].body as string;
    expect(noteBody).toContain("Close target moved to"); // the date line precedes the reason
    expect(noteBody).toContain(FUTURE.slice(0, 4)); // the moved-to year is in the body
    // the date write must precede the note (the date drives the SLA; the note is the audit layer)
    expect(mocks.updateDeal.mock.invocationCallOrder[0]).toBeLessThan(mocks.createActivity.mock.invocationCallOrder[0]);
    expect(mocks.onSaved).toHaveBeenCalled();
    expect(mocks.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("still refreshes + closes when only the audit note fails (the date is already saved)", async () => {
    mocks.createActivity.mockRejectedValueOnce(new Error("note service down"));
    const c = render();
    setValue(c.querySelector("#move-close-date") as HTMLInputElement, FUTURE);
    setValue(c.querySelector("#move-close-reason") as HTMLTextAreaElement, "Client pushed to Q4");

    await act(async () => {
      saveButton(c).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mocks.updateDeal).toHaveBeenCalledTimes(1);
    expect(mocks.onSaved).toHaveBeenCalled(); // refetch still runs
    expect(mocks.onOpenChange).toHaveBeenCalledWith(false); // dialog closes — no stranded date / duplicate retry
    expect(c.textContent).not.toContain("Couldn't move the close date");
  });

  it("seeds the picker from the deal's current close date", () => {
    const c = render(FUTURE);
    expect((c.querySelector("#move-close-date") as HTMLInputElement).value).toBe(FUTURE);
  });

  it("offers Remove postponement ONLY when the deal has an active (future) close target", () => {
    const removeBtn = (c: HTMLElement) =>
      Array.from(c.querySelectorAll("button")).find((b) => b.textContent?.includes("Remove postponement"));
    expect(removeBtn(render(null))).toBeUndefined(); // nothing postponed
    expect(removeBtn(render("2020-01-01"))).toBeUndefined(); // a past date isn't postponing the SLA
    expect(removeBtn(render(FUTURE))).toBeDefined(); // active postponement -> offer the undo
  });

  it("Remove postponement clears the close date, logs a note, refreshes + closes", async () => {
    const c = render(FUTURE);
    const removeBtn = Array.from(c.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Remove postponement")
    )!;
    await act(async () => {
      removeBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mocks.updateDeal).toHaveBeenCalledWith("deal-1", { expectedCloseDate: null });
    expect(mocks.createActivity).toHaveBeenCalledWith(
      expect.objectContaining({ type: "note", dealId: "deal-1" })
    );
    expect(mocks.onSaved).toHaveBeenCalled();
    expect(mocks.onOpenChange).toHaveBeenCalledWith(false);
  });
});
