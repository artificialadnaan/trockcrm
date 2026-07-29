// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmailRow } from "./email-row";
import type { Email } from "@/hooks/use-emails";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const email = {
  id: "e1",
  graphMessageId: "graph-1",
  direction: "inbound",
  fromAddress: "a@example.com",
  toAddresses: ["b@example.com"],
  ccAddresses: [],
  subject: "Re: roof scope",
  bodyPreview: "…",
  bodyHtml: null,
  hasAttachments: false,
  contactId: null,
  dealId: null,
  graphConversationId: "conv-1",
  userId: "user-1",
  sentAt: new Date().toISOString(),
  syncedAt: new Date().toISOString(),
} as unknown as Email;

let root: Root | null = null;
let container: HTMLElement | null = null;

function mount(node: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container!);
    root!.render(node);
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function findButtonByLabel(label: RegExp) {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
    label.test(button.getAttribute("aria-label") ?? ""),
  ) ?? null;
}

function findMenuItem(label: RegExp) {
  return Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((item) =>
    label.test(item.textContent ?? ""),
  ) ?? null;
}

describe("EmailRow actions", () => {
  it("renders no action menu when no handlers are supplied", () => {
    mount(<EmailRow email={email} />);
    expect(findButtonByLabel(/email actions/i)).toBeNull();
  });

  it("calls onReassign without selecting the row", () => {
    const onReassign = vi.fn();
    const onClick = vi.fn();
    mount(<EmailRow email={email} onClick={onClick} onReassign={onReassign} onUnassign={vi.fn()} />);

    const trigger = findButtonByLabel(/email actions/i);
    expect(trigger).not.toBeNull();
    act(() => trigger!.click());

    const reassignItem = findMenuItem(/reassign/i);
    expect(reassignItem).not.toBeNull();
    act(() => reassignItem!.click());

    expect(onReassign).toHaveBeenCalledWith(email);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("calls onUnassign without selecting the row", () => {
    const onUnassign = vi.fn();
    const onClick = vi.fn();
    mount(<EmailRow email={email} onClick={onClick} onReassign={vi.fn()} onUnassign={onUnassign} />);

    const trigger = findButtonByLabel(/email actions/i);
    act(() => trigger!.click());

    const unassignItem = findMenuItem(/unassign/i);
    expect(unassignItem).not.toBeNull();
    act(() => unassignItem!.click());

    expect(onUnassign).toHaveBeenCalledWith(email);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("is keyboard-operable: Enter opens the item menu, Enter on a menu item activates it", () => {
    const onReassign = vi.fn();
    const onClick = vi.fn();
    mount(<EmailRow email={email} onClick={onClick} onReassign={onReassign} onUnassign={vi.fn()} />);

    const trigger = findButtonByLabel(/email actions/i);
    expect(trigger).not.toBeNull();
    trigger!.focus();
    expect(document.activeElement).toBe(trigger);

    // A native <button> converts a keyboard Enter/Space press into a "click" via the browser's
    // own default action; jsdom does not implement that default action, so we invoke it directly
    // to stand in for the browser (this is the same reasoning applied throughout this suite, see
    // lead-detail-page.test.tsx's trigger.focus() + trigger.click() pattern).
    act(() => trigger!.click());

    const reassignItem = findMenuItem(/reassign/i);
    expect(reassignItem).not.toBeNull();
    reassignItem!.focus();

    act(() => {
      reassignItem!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });

    expect(onReassign).toHaveBeenCalledWith(email);
    expect(onClick).not.toHaveBeenCalled();
  });
});
