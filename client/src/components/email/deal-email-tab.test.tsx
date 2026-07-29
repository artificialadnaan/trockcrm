// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DealEmailTab } from "./deal-email-tab";
import type { Email, EmailAssociationTarget, EmailThread } from "@/hooks/use-emails";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  useDealEmailsMock: vi.fn(),
  useEmailThreadMock: vi.fn(),
  reassignEmailThreadMock: vi.fn(),
  detachEmailThreadMock: vi.fn(),
  associateEmailToEntityMock: vi.fn(),
  refetchMock: vi.fn(),
  toastSuccessMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock("@/hooks/use-emails", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/use-emails")>("@/hooks/use-emails");
  return {
    ...actual,
    useDealEmails: mocks.useDealEmailsMock,
    useEmailThread: mocks.useEmailThreadMock,
    reassignEmailThread: mocks.reassignEmailThreadMock,
    detachEmailThread: mocks.detachEmailThreadMock,
    associateEmailToEntity: mocks.associateEmailToEntityMock,
  };
});

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccessMock,
    error: mocks.toastErrorMock,
  },
}));

vi.mock("./graph-auth-banner", () => ({
  GraphAuthBanner: () => null,
}));

vi.mock("./email-compose-dialog", () => ({
  EmailComposeDialog: () => null,
}));

const PICKED_TARGET: EmailAssociationTarget = {
  assignedEntityType: "deal",
  assignedEntityId: "deal-2",
  assignedDealId: "deal-2",
  displayLabel: "TR-2026-0002 · Beta Roof",
};

// Stands in for the real picker, and deliberately reproduces its ONE behavioural contract: close on a
// resolved onAssign, stay open (surfacing the error inline) when it rejects. Tests that assert the
// error path would otherwise pass against a tab that swallowed failures.
vi.mock("./email-manual-assignment-dialog", () => ({
  EmailManualAssignmentDialog: ({
    open,
    onOpenChange,
    onAssign,
    title,
    description,
    searchTypes,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onAssign: (target: EmailAssociationTarget) => Promise<void>;
    title?: string;
    description?: string;
    searchTypes?: string[];
  }) =>
    open ? (
      <div data-testid="assignment-dialog" data-search-types={(searchTypes ?? []).join(",")}>
        <h2 data-testid="assignment-title">{title}</h2>
        <p data-testid="assignment-description">{description}</p>
        <button
          type="button"
          onClick={() => {
            onAssign(PICKED_TARGET).then(
              () => onOpenChange(false),
              () => undefined
            );
          }}
        >
          Pick deal
        </button>
      </div>
    ) : null,
}));

function makeEmail(overrides: Partial<Email> = {}): Email {
  return {
    id: "email-1",
    graphMessageId: "graph-1",
    graphConversationId: "conv-1",
    direction: "inbound",
    fromAddress: "customer@example.com",
    toAddresses: ["rep@trockgc.com"],
    ccAddresses: [],
    subject: "Re: roof scope",
    bodyPreview: "Sending the revised scope",
    bodyHtml: null,
    hasAttachments: false,
    contactId: null,
    dealId: "deal-1",
    userId: "user-1",
    sentAt: "2026-07-20T15:00:00.000Z",
    syncedAt: "2026-07-20T15:01:00.000Z",
    ...overrides,
  };
}

function makeThread(messageCount: number, conversationId: string | null = "conv-1"): EmailThread {
  return {
    binding: null,
    preview: null,
    emails: Array.from({ length: messageCount }).map((_, index) =>
      makeEmail({ id: `thread-${index}`, graphConversationId: conversationId })
    ),
  };
}

let root: Root | null = null;
let container: HTMLElement | null = null;

function mount(emails: Email[] = [makeEmail()]) {
  mocks.useDealEmailsMock.mockReturnValue({
    emails,
    pagination: { page: 1, limit: 20, total: emails.length, totalPages: 1 },
    loading: false,
    error: null,
    refetch: mocks.refetchMock,
  });

  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container!);
    root!.render(<DealEmailTab dealId="deal-1" />);
  });
  return container;
}

// Matched on the aria-label rather than an exact string so a wording tweak in EmailRow (which this
// suite does not own) fails there, where it belongs, and not here.
function actionsTrigger() {
  return (
    Array.from(container!.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      /email actions/i.test(button.getAttribute("aria-label") ?? "")
    ) ?? null
  );
}

function findMenuItem(label: RegExp) {
  return (
    Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((item) =>
      label.test(item.textContent ?? "")
    ) ?? null
  );
}

function findButton(label: RegExp) {
  return (
    Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      label.test(button.textContent ?? "")
    ) ?? null
  );
}

// Never call this from inside an `await act(async () => ...)`: the nested sync act does not flush, so
// the portaled menu content is not in the DOM yet when findMenuItem runs. Call it directly, then
// flushAsync() to settle whatever the menu item kicked off.
function openRowAction(label: RegExp) {
  const trigger = actionsTrigger();
  expect(trigger).not.toBeNull();
  act(() => trigger!.click());
  const item = findMenuItem(label);
  expect(item).not.toBeNull();
  act(() => item!.click());
}

async function flushAsync() {
  await act(async () => {});
}

function dialogDescription() {
  return document.body.querySelector('[data-testid="assignment-description"]')?.textContent ?? "";
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.reassignEmailThreadMock.mockResolvedValue({ success: true });
  mocks.detachEmailThreadMock.mockResolvedValue({ success: true });
  mocks.associateEmailToEntityMock.mockResolvedValue({ success: true });
  mocks.useEmailThreadMock.mockReturnValue({
    thread: makeThread(4),
    loading: false,
    error: null,
    refetch: vi.fn(),
    setThread: vi.fn(),
  });
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

describe("DealEmailTab reassignment wiring", () => {
  it("reassigns the whole conversation to the picked deal", async () => {
    mount();
    openRowAction(/reassign/i);

    expect(document.body.querySelector('[data-testid="assignment-dialog"]')).not.toBeNull();
    expect(
      document.body.querySelector('[data-testid="assignment-dialog"]')?.getAttribute("data-search-types")
    ).toBe("deal");

    await act(async () => {
      findButton(/pick deal/i)!.click();
    });

    expect(mocks.reassignEmailThreadMock).toHaveBeenCalledWith("conv-1", "deal-2");
    expect(mocks.associateEmailToEntityMock).not.toHaveBeenCalled();
    expect(mocks.toastSuccessMock).toHaveBeenCalled();
    expect(mocks.refetchMock).toHaveBeenCalled();
    expect(document.body.querySelector('[data-testid="assignment-dialog"]')).toBeNull();
  });

  it("shows the blast radius from the thread before the user commits", () => {
    mount();
    openRowAction(/reassign/i);

    expect(mocks.useEmailThreadMock).toHaveBeenCalledWith("conv-1");
    expect(dialogDescription()).toContain("4 messages");
  });

  it("unassigns the conversation after a confirmation that names the assignment queue", async () => {
    mount();

    openRowAction(/unassign/i);
    await flushAsync();

    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("assignment queue"));
    expect(mocks.detachEmailThreadMock).toHaveBeenCalledWith("conv-1");
    expect(mocks.toastSuccessMock).toHaveBeenCalled();
    expect(mocks.refetchMock).toHaveBeenCalled();
  });

  it("does not unassign when the confirmation is declined", async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    mount();

    openRowAction(/unassign/i);
    await flushAsync();

    expect(mocks.detachEmailThreadMock).not.toHaveBeenCalled();
    expect(mocks.refetchMock).not.toHaveBeenCalled();
  });

  it("falls back to the single-message move when the email has no conversation id, and says so", async () => {
    const orphan = makeEmail({ id: "email-orphan", graphConversationId: null });
    mocks.useEmailThreadMock.mockReturnValue({
      thread: makeThread(0, null),
      loading: false,
      error: null,
      refetch: vi.fn(),
      setThread: vi.fn(),
    });
    mount([orphan]);
    openRowAction(/reassign/i);

    expect(dialogDescription()).toContain("only it will move");
    expect(dialogDescription()).not.toContain("messages");

    await act(async () => {
      findButton(/pick deal/i)!.click();
    });

    expect(mocks.associateEmailToEntityMock).toHaveBeenCalledWith("email-orphan", PICKED_TARGET);
    expect(mocks.reassignEmailThreadMock).not.toHaveBeenCalled();
    expect(mocks.toastSuccessMock).toHaveBeenCalled();
    expect(mocks.refetchMock).toHaveBeenCalled();
  });

  it("refuses to unassign an email with no conversation id instead of failing obscurely", async () => {
    mount([makeEmail({ graphConversationId: null })]);

    openRowAction(/unassign/i);
    await flushAsync();

    expect(mocks.detachEmailThreadMock).not.toHaveBeenCalled();
    expect(mocks.toastErrorMock).toHaveBeenCalled();
  });

  it("surfaces a server permission denial on reassign as a readable toast and keeps the picker open", async () => {
    mocks.reassignEmailThreadMock.mockRejectedValue(
      new Error("You can only modify your own email threads")
    );
    mount();
    openRowAction(/reassign/i);

    await act(async () => {
      findButton(/pick deal/i)!.click();
    });

    expect(mocks.toastErrorMock).toHaveBeenCalledWith("You can only modify your own email threads");
    expect(mocks.refetchMock).not.toHaveBeenCalled();
    expect(document.body.querySelector('[data-testid="assignment-dialog"]')).not.toBeNull();
  });

  it("surfaces a server permission denial on unassign as a readable toast", async () => {
    mocks.detachEmailThreadMock.mockRejectedValue(
      new Error("You can only modify your own email threads")
    );
    mount();

    openRowAction(/unassign/i);
    await flushAsync();

    expect(mocks.toastErrorMock).toHaveBeenCalledWith("You can only modify your own email threads");
    expect(mocks.refetchMock).not.toHaveBeenCalled();
  });
});
