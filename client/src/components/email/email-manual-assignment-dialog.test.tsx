// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmailManualAssignmentDialog } from "./email-manual-assignment-dialog";
import type { EmailAssociationTarget } from "@/hooks/use-emails";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * This component had NO test of its own while THREE suites stubbed it, and the deal Emails tab leans on
 * one specific behaviour of it: onAssign resolving closes the dialog, onAssign rejecting leaves it open
 * with the message inline. That is what makes deal-email-tab.tsx rethrow after toasting a 403 — swallow
 * the error and the picker would close as though the move had worked.
 *
 * Pinned here, against the REAL component, so the stubs elsewhere cannot drift away from it silently.
 *
 * `safeOptions` is the seam used to reach the Assign button: it renders an actionable row with no
 * search, so nothing here needs the network. The search path is a separate concern.
 */

const TARGET: EmailAssociationTarget = {
  assignedEntityType: "deal",
  assignedEntityId: "deal-2",
  assignedDealId: "deal-2",
  displayLabel: "TR-2026-0002 · Beta Roof",
};

let root: Root | null = null;
let container: HTMLElement | null = null;

function mount(onAssign: (target: EmailAssociationTarget) => Promise<void>, onOpenChange = vi.fn()) {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container!);
    root!.render(
      <EmailManualAssignmentDialog
        open
        onOpenChange={onOpenChange}
        onAssign={onAssign}
        safeOptions={[{ label: "TR-2026-0002 · Beta Roof", value: TARGET }]}
      />
    );
  });
  return { onOpenChange };
}

function assignButton() {
  return (
    Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      /^assign$/i.test(button.textContent?.trim() ?? "")
    ) ?? null
  );
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("EmailManualAssignmentDialog assign contract", () => {
  it("closes itself when onAssign resolves", async () => {
    const onAssign = vi.fn(async () => {});
    const { onOpenChange } = mount(onAssign);

    const button = assignButton();
    expect(button).not.toBeNull();
    await act(async () => {
      button!.click();
    });

    expect(onAssign).toHaveBeenCalledWith(TARGET);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("stays open and shows the error inline when onAssign rejects", async () => {
    const onAssign = vi.fn(async () => {
      throw new Error("You can only modify your own email threads");
    });
    const { onOpenChange } = mount(onAssign);

    await act(async () => {
      assignButton()!.click();
    });

    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(document.body.textContent).toContain("You can only modify your own email threads");
  });

  it("re-enables the Assign button after a rejection, so the user can retry", async () => {
    const onAssign = vi.fn(async () => {
      throw new Error("nope");
    });
    mount(onAssign);

    await act(async () => {
      assignButton()!.click();
    });

    expect(assignButton()?.disabled).toBe(false);
  });
});
