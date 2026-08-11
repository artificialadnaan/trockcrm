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

// EmailThreadView renders for real in the thread-view tests below, and its assignment dialog calls
// useDeals unconditionally (the hook runs whether or not the dialog is open). One row, so the reassign
// test has a deal to pick that is NOT the one the thread is already bound to — picking the current deal
// would leave the dialog's confirm button enabled but the move a no-op.
vi.mock("@/hooks/use-deals", () => ({
  useDeals: () => ({
    deals: [
      {
        id: "deal-2",
        name: "Beta Roof",
        dealNumber: "TR-2026-0002",
        projectNumber: null,
        propertyAddress: "500 Elm St",
      },
    ],
    loading: false,
  }),
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

// What the stub picker hands back. A `let` so one case can model a picker widened past deals without
// every other case having to care; reset to PICKED_TARGET in beforeEach.
let pickedTarget: EmailAssociationTarget = PICKED_TARGET;

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
            onAssign(pickedTarget).then(
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

function makeThread(
  messageCount: number,
  conversationId: string | null = "conv-1",
  binding: EmailThread["binding"] = null
): EmailThread {
  return {
    binding,
    preview: null,
    emails: Array.from({ length: messageCount }).map((_, index) =>
      makeEmail({ id: `thread-${index}`, graphConversationId: conversationId })
    ),
  };
}

// What useEmailThread answers with for a conversation already filed under this deal. EmailThreadView
// renders its Reassign/Detach card only when binding.dealId is set, so the thread-view tests below
// cannot reach either button without it.
function boundThreadState() {
  return {
    thread: makeThread(4, "conv-1", {
      id: "binding-1",
      mailboxAccountId: "mbx-1",
      contactId: null,
      contactName: null,
      companyId: null,
      companyName: null,
      propertyId: null,
      propertyName: null,
      leadId: null,
      leadName: null,
      dealId: "deal-1",
      dealName: "Old Deal",
      projectId: null,
      projectName: null,
      confidence: "high" as const,
      assignmentReason: "manual_thread_assignment",
    }),
    loading: false,
    error: null,
    refetch: vi.fn(),
    setThread: vi.fn(),
  };
}

let root: Root | null = null;
let container: HTMLElement | null = null;
// What useDealEmails currently answers with. A `let` rather than a fixed mockReturnValue so a test can
// model a refetch LANDING (the rows change) and not merely that refetch was called.
let dealEmails: Email[] = [];
// How many pages the fake server currently holds. Defaults to 1, which makes the mock behave exactly as
// the old fixed mockReturnValue did for every test that does not care about paging. A test that lowers
// it mid-run models the real thing: the collection shrank, and the page the tab is sitting on no longer
// exists — the server answers it with an EMPTY list and a lower totalPages.
let serverPageCount = 1;
// Every page useDealEmails was asked for, in order. The tab's page state is internal, so this is how a
// test sees which page it settled on.
let requestedPages: number[] = [];

/** The page the tab has settled on. (Array.prototype.at is above this workspace's TS lib target.) */
function lastRequestedPage() {
  return requestedPages[requestedPages.length - 1];
}

function mount(emails: Email[] = [makeEmail()]) {
  dealEmails = emails;
  mocks.useDealEmailsMock.mockImplementation((_dealId: string, filters: { page?: number } = {}) => {
    const requestedPage = filters.page ?? 1;
    requestedPages.push(requestedPage);
    const outOfRange = requestedPage > serverPageCount;
    return {
      emails: outOfRange ? [] : dealEmails,
      pagination: {
        page: requestedPage,
        limit: 20,
        total: dealEmails.length * serverPageCount,
        totalPages: serverPageCount,
      },
      loading: false,
      error: null,
      refetch: mocks.refetchMock,
    };
  });

  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container!);
    root!.render(<DealEmailTab dealId="deal-1" />);
  });
  return container;
}

// Re-runs DealEmailTab so it re-reads the hook. Stands in for the state update the real useDealEmails
// performs when its refetch resolves — EmailList's own selectedEmail survives it, exactly as in the app.
function rerender() {
  act(() => {
    root!.render(<DealEmailTab dealId="deal-1" />);
  });
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

// Exact trimmed text, for the cases where a substring match would be ambiguous — "Reassign" (the card
// button) vs "Reassign Thread" (the dialog's confirm) are both on screen at different moments.
function findButtonExact(text: string) {
  return (
    Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === text
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
  serverPageCount = 1;
  requestedPages = [];
  pickedTarget = PICKED_TARGET;
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
  mocks.refetchMock.mockImplementation(() => {});
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

  it("degrades to conversation-wide wording rather than quoting another thread's count", () => {
    // useEmailThread keeps its last payload when the conversation id changes, so the count is trusted
    // only while the loaded thread demonstrably belongs to the selected row. Without this the picker
    // would briefly quote the PREVIOUS thread's size — a wrong number about an irreversible move.
    mocks.useEmailThreadMock.mockReturnValue({
      thread: makeThread(9, "some-other-conversation"),
      loading: false,
      error: null,
      refetch: vi.fn(),
      setThread: vi.fn(),
    });
    mount();
    openRowAction(/reassign/i);

    expect(dialogDescription()).not.toContain("9");
    expect(dialogDescription()).toContain("this whole conversation");
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
    expect(dialogDescription()).not.toMatch(/Moves \d+/);
    // The associate route this falls back to is mailbox-owner-only, unlike the thread routes, so the
    // copy must not promise a collaborator a move the server will refuse.
    expect(dialogDescription()).toContain("only be moved by the mailbox they belong to");

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

  it("refetches the deal list after a detach made from the THREAD VIEW, not just the row action", async () => {
    // EmailList swaps ITSELF for EmailThreadView, so DealEmailTab never unmounts and useDealEmails
    // never refetches on its own. Before onThreadChanged existed, detaching here left the conversation
    // still listed under the deal the instant the user pressed Back — the same stale list the row
    // action's refetch prevents, on the button people are far more likely to reach for.
    mocks.useEmailThreadMock.mockReturnValue({
      ...boundThreadState(),
    });
    // Model the refetch actually landing: the conversation has left this deal, so the next read of the
    // deal's emails returns nothing.
    mocks.refetchMock.mockImplementation(() => {
      dealEmails = [];
    });

    mount();

    // Click the row itself (not its overflow menu) to open the thread view in place.
    const row = container!.querySelector<HTMLElement>(".cursor-pointer");
    expect(row).not.toBeNull();
    act(() => row!.click());

    const detachButton = findButton(/detach/i);
    expect(detachButton).not.toBeNull();
    await act(async () => {
      detachButton!.click();
    });

    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("assignment queue"));
    expect(mocks.detachEmailThreadMock).toHaveBeenCalledWith("conv-1");
    expect(mocks.refetchMock).toHaveBeenCalled();

    // …and the list the user comes back to is genuinely empty, which is the thing that was broken.
    rerender();
    const backButton = findButton(/back/i);
    expect(backButton).not.toBeNull();
    act(() => backButton!.click());

    expect(container!.textContent).toContain("No emails linked to this deal yet.");
  });

  it("refetches the deal list after a REASSIGN made from the thread view", async () => {
    // The same hole as the detach path, on the same shared callback. Untested is how the original
    // server-side no-op survived six rounds of review, so this asserts the outcome rather than trusting
    // that one wiring covers both handlers.
    mocks.useEmailThreadMock.mockReturnValue(boundThreadState());
    mocks.refetchMock.mockImplementation(() => {
      dealEmails = [];
    });

    mount();
    act(() => container!.querySelector<HTMLElement>(".cursor-pointer")!.click());

    // Open the thread-level reassign dialog from the binding card.
    const reassignButton = findButtonExact("Reassign");
    expect(reassignButton).not.toBeNull();
    act(() => reassignButton!.click());

    // Pick a deal that is NOT the one it is bound to — the dialog pre-selects the current deal.
    const dealOption = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => /Beta Roof/.test(button.textContent ?? "")
    );
    expect(dealOption).not.toBeNull();
    act(() => dealOption!.click());

    const confirmButton = findButtonExact("Reassign Thread");
    expect(confirmButton).not.toBeNull();
    await act(async () => {
      confirmButton!.click();
    });

    expect(mocks.reassignEmailThreadMock).toHaveBeenCalledWith("conv-1", "deal-2");
    expect(mocks.refetchMock).toHaveBeenCalled();

    // …and the list behind the thread view is genuinely empty on the way back.
    rerender();
    const backButton = findButton(/back/i);
    expect(backButton).not.toBeNull();
    act(() => backButton!.click());

    expect(container!.textContent).toContain("No emails linked to this deal yet.");
  });

  it("does not refetch when a thread-view detach is declined at the confirmation", async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    mocks.useEmailThreadMock.mockReturnValue({
      ...boundThreadState(),
    });
    mount();

    act(() => container!.querySelector<HTMLElement>(".cursor-pointer")!.click());
    await act(async () => {
      findButton(/detach/i)!.click();
    });

    expect(mocks.detachEmailThreadMock).not.toHaveBeenCalled();
    expect(mocks.refetchMock).not.toHaveBeenCalled();
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

  // -----------------------------------------------------------------------------------------------
  // Paging. Moving a conversation off this deal SHRINKS the collection, so the page the user is
  // standing on can stop existing. Refetching it unchanged asks the server for a page past the end; it
  // answers with an empty list and a lower totalPages, and EmailList takes its emails.length === 0
  // early return BEFORE it renders the pager — leaving no control on screen to get back to page 1.
  // -----------------------------------------------------------------------------------------------
  async function goToLastPageOfThree() {
    serverPageCount = 3;
    mount();
    act(() => findButton(/next/i)!.click());
    act(() => findButton(/next/i)!.click());
    expect(lastRequestedPage()).toBe(3);
  }

  it("clamps back into range when unassigning empties the last page", async () => {
    await goToLastPageOfThree();
    // The refetch LANDS: the conversation left this deal, so the server now holds two pages.
    mocks.refetchMock.mockImplementation(() => {
      serverPageCount = 2;
    });

    openRowAction(/unassign/i);
    await flushAsync();
    rerender();
    await flushAsync();

    expect(mocks.detachEmailThreadMock).toHaveBeenCalledWith("conv-1");
    expect(lastRequestedPage()).toBe(2);
    // The outcome, not the mechanism: the user is looking at a page with rows on it, not the dead-end
    // empty state with no way back.
    expect(container!.textContent).not.toContain("No emails linked to this deal yet.");
    expect(container!.textContent).toContain("Page 2 of 2");
  });

  it("clamps back into range when REASSIGNING empties the last page", async () => {
    // Same hole, same shrink, the other handler. Asserted separately because "fixed on one path,
    // forgotten on the other" is the recurring shape of the bugs on this branch.
    await goToLastPageOfThree();
    mocks.refetchMock.mockImplementation(() => {
      serverPageCount = 2;
    });

    openRowAction(/reassign/i);
    await act(async () => {
      findButton(/pick deal/i)!.click();
    });
    rerender();
    await flushAsync();

    expect(mocks.reassignEmailThreadMock).toHaveBeenCalledWith("conv-1", "deal-2");
    expect(lastRequestedPage()).toBe(2);
    expect(container!.textContent).not.toContain("No emails linked to this deal yet.");
  });

  it("leaves the page alone when the one being viewed is still in range", async () => {
    // The reason this is a CLAMP and not a reset-to-1. Moving a conversation from page 1 is the common
    // case by far, and an unconditional setPage(1) would remount the list and jump the scroll position
    // every single time for no benefit. Sitting on page 2 of a still-three-page collection must not
    // move the user either.
    serverPageCount = 3;
    mount();
    act(() => findButton(/next/i)!.click());
    expect(lastRequestedPage()).toBe(2);

    openRowAction(/unassign/i);
    await flushAsync();
    rerender();
    await flushAsync();

    expect(lastRequestedPage()).toBe(2);
    expect(container!.textContent).toContain("Page 2 of 3");
  });

  // -----------------------------------------------------------------------------------------------
  // Reassigning to the deal THE ROW says it is on.
  // -----------------------------------------------------------------------------------------------
  it("still asks the server to consolidate when the picked deal matches the ROW's own deal", async () => {
    // The tab used to treat this as a no-op and close the picker without a request, comparing the
    // picked deal against the clicked ROW's `dealId`. That is the wrong scope. A reassign moves the
    // whole CONVERSATION, and a conversation is filed per-mailbox and per-message: a row on deal A does
    // not prove the other mailboxes' bindings, or its own sibling messages, are on A too. Cross-filed
    // across A and B, or left split by a per-EMAIL reassign, picking A is exactly the CONSOLIDATION the
    // user is asking for — and the tab answered it by closing silently and doing nothing.
    //
    // The check is deliberately not re-derived from the thread payload either. "Is the whole
    // conversation already on A" needs every binding AND every message, and the payload carries one
    // binding; only the server can answer it. The reassign mutation is idempotent and repairs exactly
    // this split, so the honest client behaviour is to ask. It costs one request in the genuinely
    // redundant case.
    mount([makeEmail({ dealId: "deal-2" })]);
    openRowAction(/reassign/i);

    await act(async () => {
      findButton(/pick deal/i)!.click();
    });

    expect(mocks.reassignEmailThreadMock).toHaveBeenCalledWith("conv-1", "deal-2");
    expect(mocks.associateEmailToEntityMock).not.toHaveBeenCalled();
    expect(mocks.toastSuccessMock).toHaveBeenCalled();
    expect(mocks.refetchMock).toHaveBeenCalled();
    expect(document.body.querySelector('[data-testid="assignment-dialog"]')).toBeNull();
  });

  it("still refuses a non-deal target whose id matches the row's current deal", async () => {
    // The entity-type check is the one thing that must stay in front: a picker widened past deals could
    // hand over a CONTACT whose id happens to equal the deal's, and it is the refusal here that stops a
    // non-deal id reaching a deal-keyed route.
    pickedTarget = {
      assignedEntityType: "contact",
      assignedEntityId: "deal-2",
      assignedDealId: null,
      displayLabel: "A contact, not a deal",
    };
    mount([makeEmail({ dealId: "deal-2" })]);
    openRowAction(/reassign/i);

    await act(async () => {
      findButton(/pick deal/i)!.click();
    });

    expect(mocks.reassignEmailThreadMock).not.toHaveBeenCalled();
    expect(mocks.toastErrorMock).toHaveBeenCalledWith("A conversation can only be reassigned to a deal.");
    // Rejected, so the picker stays open with the reason rather than closing on a silent no-op.
    expect(document.body.querySelector('[data-testid="assignment-dialog"]')).not.toBeNull();
  });

  it("still moves a conversation whose current deal is not the picked one", async () => {
    // The ordinary move, unchanged.
    mount([makeEmail({ dealId: "deal-1" })]);
    openRowAction(/reassign/i);

    await act(async () => {
      findButton(/pick deal/i)!.click();
    });

    expect(mocks.reassignEmailThreadMock).toHaveBeenCalledWith("conv-1", "deal-2");
    expect(mocks.toastSuccessMock).toHaveBeenCalled();
  });
});
