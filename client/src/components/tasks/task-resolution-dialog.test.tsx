// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div role="dialog">{children}</div> : null),
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => <p {...props}>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, variant: _variant, ...props }: { children: ReactNode; variant?: string } & Record<string, unknown>) => (
    <button {...props}>{children}</button>
  ),
}));

import { TaskResolutionDialog } from "./task-resolution-dialog";

let container: HTMLDivElement;
let root: Root;

function setTextareaValue(value: string) {
  const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
  if (!textarea) throw new Error("Task resolution textarea was not rendered");
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (!setter) throw new Error("Textarea value setter was not available");
  act(() => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("TaskResolutionDialog", () => {
  it("keeps the terminal action unavailable until an explanation is provided", () => {
    const onResolve = vi.fn();
    act(() => {
      root.render(
        <TaskResolutionDialog
          action="complete"
          open
          taskTitle="Call Palm Villas"
          onOpenChange={() => {}}
          onResolve={onResolve}
        />
      );
    });

    expect(container.textContent).toContain("What action did you take?");
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);

    setTextareaValue("   ");

    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("sends a trimmed explanation and keeps an API error visible", async () => {
    const onResolve = vi.fn().mockRejectedValue(new Error("The task could not be closed"));
    const onOpenChange = vi.fn();
    act(() => {
      root.render(
        <TaskResolutionDialog
          action="dismiss"
          open
          taskTitle="Call Palm Villas"
          onOpenChange={onOpenChange}
          onResolve={onResolve}
        />
      );
    });

    setTextareaValue("  Customer already completed this with the project manager.  ");

    await act(async () => {
      container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(onResolve).toHaveBeenCalledWith("Customer already completed this with the project manager.");
    expect(container.textContent).toContain("The task could not be closed");
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("does not close a newer task context after an earlier resolution succeeds", async () => {
    const onResolve = vi.fn().mockResolvedValue(false);
    const onOpenChange = vi.fn();
    const onResolved = vi.fn();
    act(() => {
      root.render(
        <TaskResolutionDialog
          action="complete"
          open
          taskTitle="Call Palm Villas"
          onOpenChange={onOpenChange}
          onResolve={onResolve}
          onResolved={onResolved}
        />
      );
    });

    setTextareaValue("Verified the delivery with the customer.");
    await act(async () => {
      container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(onResolve).toHaveBeenCalledWith("Verified the delivery with the customer.");
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(onResolved).not.toHaveBeenCalled();
  });
});
