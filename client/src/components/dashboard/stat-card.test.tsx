// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StatCard } from "./stat-card";

let root: Root | undefined;
let container: HTMLElement | undefined;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

async function renderNode(node: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(node);
  });
}

describe("StatCard", () => {
  it("is a keyboard-operable button when given onClick (focusable + Enter/Space activate)", async () => {
    const onClick = vi.fn();
    await renderNode(<StatCard title="Won Commission" value="$0" onClick={onClick} />);

    const card = container!.querySelector('[role="button"]') as HTMLElement | null;
    expect(card).not.toBeNull();
    expect(card?.getAttribute("tabindex")).toBe("0");

    await act(async () => {
      card!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await act(async () => {
      card!.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    });
    expect(onClick).toHaveBeenCalledTimes(2); // Enter + Space

    await act(async () => {
      card!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClick).toHaveBeenCalledTimes(3); // pointer still works

    // A non-activating key does nothing.
    await act(async () => {
      card!.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    });
    expect(onClick).toHaveBeenCalledTimes(3);
  });

  it("has no button semantics when not clickable", async () => {
    await renderNode(<StatCard title="Static" value="5" />);
    expect(container!.querySelector('[role="button"]')).toBeNull();
    expect(container!.querySelector("[tabindex]")).toBeNull();
  });
});
