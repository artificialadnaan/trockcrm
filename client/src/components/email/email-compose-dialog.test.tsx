// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmailComposeDialog } from "./email-compose-dialog";

const sendEmailMock = vi.fn();

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/hooks/use-emails", () => ({
  sendEmail: (...args: unknown[]) => sendEmailMock(...args),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("./email-manual-assignment-dialog", () => ({
  EmailManualAssignmentDialog: ({
    open,
    onAssign,
  }: {
    open: boolean;
    onAssign: (target: {
      assignedEntityType: "company";
      assignedEntityId: string;
      assignedDealId: null;
      displayLabel: string;
    }) => Promise<void> | void;
  }) =>
    open ? (
      <div data-testid="assignment-dialog">
        <button
          type="button"
          onClick={() =>
            void onAssign({
              assignedEntityType: "company",
              assignedEntityId: "company-1",
              assignedDealId: null,
              displayLabel: "Company · Alpha Roofing",
            })
          }
        >
          Select company
        </button>
      </div>
    ) : null,
}));

function getButton(container: HTMLElement, text: string) {
  const match = Array.from(container.querySelectorAll("button")).find((button) =>
    button.textContent?.includes(text)
  );
  if (!match) throw new Error(`Button not found: ${text}`);
  return match as HTMLButtonElement;
}

function getInput(_container: HTMLElement, id: string) {
  const element = document.querySelector(`#${id}`);
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
    throw new Error(`Input not found: ${id}`);
  }
  return element;
}

async function changeValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function renderDialog(props: Partial<React.ComponentProps<typeof EmailComposeDialog>> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;

  await act(async () => {
    root = createRoot(container);
    root.render(
      <EmailComposeDialog
        open
        onOpenChange={vi.fn()}
        onSent={vi.fn()}
        {...props}
      />
    );
  });

  return {
    container,
    cleanup: async () => {
      await act(async () => {
        root?.unmount();
      });
      container.remove();
    },
  };
}

describe("EmailComposeDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendEmailMock.mockResolvedValue({ email: { id: "email-1" } });
  });

  it("renders the associate-to picker and disables send until association plus required fields are filled", async () => {
    const view = await renderDialog();

    expect(view.container.textContent).toContain("Associate to");
    expect(view.container.textContent).toContain("Pick a deal, company, contact, or lead");

    const sendButton = getButton(view.container, "Send");
    expect(sendButton.disabled).toBe(true);

    const toInput = getInput(view.container, "email-to");
    const subjectInput = getInput(view.container, "email-subject");

    await changeValue(toInput, "client@example.com");
    await changeValue(subjectInput, "Project update");

    expect(sendButton.disabled).toBe(true);

    await act(async () => {
      getButton(view.container, "Pick a deal, company, contact, or lead").click();
    });

    await act(async () => {
      getButton(view.container, "Select company").click();
    });

    expect(view.container.textContent).toContain("Company · Alpha Roofing");
    expect(getButton(view.container, "Send").disabled).toBe(false);

    await view.cleanup();
  });

  it("sends the selected association target in the outbound email payload", async () => {
    const onSent = vi.fn();
    const onOpenChange = vi.fn();
    const view = await renderDialog({ onSent, onOpenChange });

    await act(async () => {
      getButton(view.container, "Pick a deal, company, contact, or lead").click();
    });
    await act(async () => {
      getButton(view.container, "Select company").click();
    });

    const toInput = getInput(view.container, "email-to");
    const subjectInput = getInput(view.container, "email-subject");
    const bodyInput = getInput(view.container, "email-body");

    await changeValue(toInput, "client@example.com");
    await changeValue(subjectInput, "Project update");
    await changeValue(bodyInput, "Hello there");

    await act(async () => {
      getButton(view.container, "Send").click();
    });

    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ["client@example.com"],
        subject: "Project update",
        assignedEntityType: "company",
        assignedEntityId: "company-1",
      })
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSent).toHaveBeenCalled();

    await view.cleanup();
  });

  it("preselects the deal association when opened from a deal tab and maps the send payload to deal fields", async () => {
    const view = await renderDialog({
      dealId: "deal-1",
      defaultTo: "client@example.com",
      defaultSubject: "Deal follow-up",
    });

    expect(view.container.textContent).toContain("Deal selected");

    const sendButton = getButton(view.container, "Send");
    expect(sendButton.disabled).toBe(false);

    const bodyInput = getInput(view.container, "email-body");
    await changeValue(bodyInput, "Checking in");

    await act(async () => {
      getButton(view.container, "Send").click();
    });

    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        assignedEntityType: "deal",
        assignedEntityId: "deal-1",
        assignedDealId: "deal-1",
        dealId: "deal-1",
        contactId: null,
      })
    );

    await view.cleanup();
  });

  it("preselects the contact association when opened from a contact tab and maps the send payload to contact fields", async () => {
    const view = await renderDialog({
      contactId: "contact-1",
      defaultTo: "client@example.com",
      defaultSubject: "Contact follow-up",
    });

    expect(view.container.textContent).toContain("Contact selected");

    const bodyInput = getInput(view.container, "email-body");
    await changeValue(bodyInput, "Checking in");

    await act(async () => {
      getButton(view.container, "Send").click();
    });

    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        assignedEntityType: "contact",
        assignedEntityId: "contact-1",
        assignedDealId: null,
        dealId: null,
        contactId: "contact-1",
      })
    );

    await view.cleanup();
  });
});
