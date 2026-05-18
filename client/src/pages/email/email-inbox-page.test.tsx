// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmailInboxPage } from "./email-inbox-page";
import type { Email, EmailFilters, Pagination } from "@/hooks/use-emails";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  useUserEmailsMock: vi.fn(),
  useGraphAuthMock: vi.fn(),
  updateEmailActionMock: vi.fn(),
  associateEmailToEntityMock: vi.fn(),
  assignTarget: {
    assignedEntityType: "deal",
    assignedEntityId: "deal-2",
    assignedDealId: "deal-2",
  },
}));

vi.mock("@/hooks/use-emails", () => ({
  useUserEmails: mocks.useUserEmailsMock,
  updateEmailAction: mocks.updateEmailActionMock,
  associateEmailToEntity: mocks.associateEmailToEntityMock,
}));

vi.mock("@/hooks/use-graph-auth", () => ({
  useGraphAuth: mocks.useGraphAuthMock,
}));

vi.mock("@/components/email/graph-auth-banner", () => ({
  GraphAuthBanner: ({ auth }: { auth?: { connected: boolean } }) => (
    <div data-testid="graph-auth-banner" data-connected={String(auth?.connected)} />
  ),
}));

vi.mock("@/components/email/email-assignment-queue", () => ({
  useEmailAssignmentQueue: () => ({
    items: [],
    loading: false,
    error: null,
    page: 1,
    pagination: {
      page: 1,
      limit: 10,
      total: 2,
      totalPages: 1,
    },
    setPage: vi.fn(),
    refresh: vi.fn(),
    assign: vi.fn(),
  }),
  EmailAssignmentQueuePanel: () => (
    <section data-testid="parking-lot-intake">
      Parking Lot Intake
      <article>Vendor invoice needs review</article>
    </section>
  ),
}));

vi.mock("@/components/email/email-thread-view", () => ({
  EmailThreadView: ({ conversationId }: { conversationId: string }) => (
    <div>Thread tools for {conversationId}</div>
  ),
}));

vi.mock("@/components/email/email-compose-dialog", () => ({
  EmailComposeDialog: ({
    open,
    defaultTo,
    defaultSubject,
    defaultBody,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSent?: () => void;
    defaultTo?: string;
    defaultSubject?: string;
    defaultBody?: string;
  }) => (
    open ? (
      <div role="dialog">
        Compose open to: {defaultTo ?? "new message"}
        {defaultSubject ? <p>Subject: {defaultSubject}</p> : null}
        {defaultBody ? <p>Body: {defaultBody}</p> : null}
      </div>
    ) : null
  ),
}));

vi.mock("@/components/email/email-manual-assignment-dialog", () => ({
  EmailManualAssignmentDialog: ({
    open,
    onAssign,
  }: {
    open: boolean;
    onAssign: (target: typeof mocks.assignTarget) => Promise<void>;
  }) =>
    open ? (
      <div role="dialog">
        Manual assignment
        <button type="button" onClick={() => void onAssign(mocks.assignTarget)}>
          Assign to Dallas ISD
        </button>
      </div>
    ) : null,
}));

const pagination: Pagination = {
  page: 1,
  limit: 25,
  total: 3,
  totalPages: 1,
};

const fixtureEmails: Email[] = [
  {
    id: "email-1",
    graphMessageId: "graph-1",
    graphConversationId: "conversation-1",
    direction: "inbound",
    fromAddress: "marcus.holloway@dallasisd.org",
    toAddresses: ["brett@trockconstruction.com"],
    ccAddresses: null,
    subject: "Building A roof phase 2 timeline",
    bodyPreview: "Need bid pricing locked by May 28.",
    bodyHtml: "<p>Confirmed the phasing window and bid pricing deadline.</p>",
    hasAttachments: true,
    isStarred: false,
    archivedAt: null,
    deletedAt: null,
    contactId: "contact-1",
    dealId: "deal-1",
    assignedEntityType: "deal",
    assignedEntityId: "deal-1",
    assignmentAmbiguityReason: null,
    userId: "user-1",
    sentAt: new Date().toISOString(),
    syncedAt: new Date().toISOString(),
  },
  {
    id: "email-2",
    graphMessageId: "graph-2",
    graphConversationId: null,
    direction: "inbound",
    fromAddress: "linda.park@friscologistics.com",
    toAddresses: ["brett@trockconstruction.com"],
    ccAddresses: null,
    subject: "Frisco DC re-roof checking timing",
    bodyPreview: "Will the timeline you sent last week still hold?",
    bodyHtml: "<p>Our board meets next Tuesday and I want to bring your bid.</p>",
    hasAttachments: false,
    isStarred: false,
    archivedAt: null,
    deletedAt: null,
    contactId: null,
    dealId: null,
    assignedEntityType: null,
    assignedEntityId: null,
    assignmentAmbiguityReason: null,
    userId: "user-1",
    sentAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    syncedAt: new Date().toISOString(),
  },
  {
    id: "email-3",
    graphMessageId: "graph-3",
    graphConversationId: null,
    direction: "outbound",
    fromAddress: "brett@trockconstruction.com",
    toAddresses: ["marcus.holloway@dallasisd.org"],
    ccAddresses: null,
    subject: "Updated SOV - Dallas ISD Bldg A",
    bodyPreview: "Attached the revised SOV with drain line items.",
    bodyHtml: "<p>Attached the revised SOV.</p>",
    hasAttachments: false,
    isStarred: false,
    archivedAt: null,
    deletedAt: null,
    contactId: "contact-1",
    dealId: "deal-1",
    assignedEntityType: "deal",
    assignedEntityId: "deal-1",
    assignmentAmbiguityReason: null,
    userId: "user-1",
    sentAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    syncedAt: new Date().toISOString(),
  },
];

function emailsForFilters(filters: EmailFilters = {}) {
  return fixtureEmails.filter((email) => {
    if (filters.direction && email.direction !== filters.direction) return false;
    if (filters.filter === "sent" && email.direction !== "outbound") return false;
    if (
      (filters.filter === "unread" || filters.filter === "unassigned") &&
      (email.direction !== "inbound" || email.assignedEntityId || email.dealId || email.contactId)
    ) {
      return false;
    }
    if (filters.search) {
      const q = filters.search.toLowerCase();
      return [email.subject, email.bodyPreview, email.fromAddress]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(q));
    }
    return true;
  });
}

const backendCounts = {
  all: 37,
  unread: 11,
  unassigned: 9,
  sent: 14,
  linked: 28,
  today: 6,
};

function mountPage(path = "/email") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;

  act(() => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <EmailInboxPage />
      </MemoryRouter>
    );
  });

  return {
    container,
    unmount() {
      act(() => root?.unmount());
      container.remove();
    },
  };
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function clickByText(container: HTMLElement, text: string) {
  const target = Array.from(container.querySelectorAll("button")).find((button) =>
    button.textContent?.includes(text)
  );
  expect(target, `button containing ${text}`).toBeTruthy();
  act(() => {
    target!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function clickByTextAsync(container: HTMLElement, text: string) {
  const target = Array.from(container.querySelectorAll("button")).find((button) =>
    button.textContent?.includes(text)
  );
  expect(target, `button containing ${text}`).toBeTruthy();
  await act(async () => {
    target!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

async function clickByLabelAsync(container: HTMLElement, label: string) {
  const target = container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;
  expect(target, `button aria-label ${label}`).toBeTruthy();
  await act(async () => {
    target!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

describe("EmailInboxPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mocks.useGraphAuthMock.mockReturnValue({
      connected: false,
      status: "not_connected",
      errorMessage: null,
      loading: false,
      startConsent: vi.fn(),
    });
    mocks.useUserEmailsMock.mockImplementation((filters: EmailFilters = {}) => ({
      emails: emailsForFilters(filters),
      pagination,
      counts: backendCounts,
      loading: false,
      error: null,
      refetch: vi.fn(),
    }));
    mocks.updateEmailActionMock.mockResolvedValue({ email: fixtureEmails[0] });
    mocks.associateEmailToEntityMock.mockResolvedValue({ success: true });
  });

  it("renders inbox with thread list and reader pane", () => {
    const page = mountPage();

    expect(page.container.textContent).toContain("Email");
    expect(page.container.textContent).toContain("Building A roof phase 2 timeline");
    expect(page.container.textContent).toContain("Confirmed the phasing window");
    expect(page.container.textContent).toContain("Parking Lot Intake");

    page.unmount();
  });

  it("selecting a thread updates the reader", () => {
    const page = mountPage();

    clickByText(page.container, "Frisco DC re-roof checking timing");

    expect(page.container.textContent).toContain("Our board meets next Tuesday");
    expect(page.container.textContent).not.toContain("Confirmed the phasing window and bid pricing deadline.");

    page.unmount();
  });

  it("folder tabs switch the inbox view", () => {
    const page = mountPage();

    clickByText(page.container, "Sent");

    expect(page.container.textContent).toContain("Updated SOV - Dallas ISD Bldg A");
    expect(mocks.useUserEmailsMock).toHaveBeenLastCalledWith({
      filter: "sent",
      search: undefined,
      page: 1,
      limit: 25,
    });

    page.unmount();
  });

  it("search filters threads", () => {
    const page = mountPage();
    const input = page.container.querySelector('input[placeholder="Search inbox"]') as HTMLInputElement;

    act(() => {
      setInputValue(input, "frisco");
    });

    expect(page.container.textContent).toContain("Frisco DC re-roof checking timing");
    expect(page.container.textContent).not.toContain("Building A roof phase 2 timeline");

    page.unmount();
  });

  it("unread thread shows unread indicator", () => {
    const page = mountPage();

    expect(page.container.querySelector('[aria-label="Unread"]')).toBeTruthy();

    page.unmount();
  });

  it("reply composer opens when reply clicked", () => {
    const page = mountPage();

    clickByText(page.container, "Reply");

    expect(page.container.textContent).toContain("Compose open to: marcus.holloway@dallasisd.org");

    page.unmount();
  });

  it("keeps OAuth callback feedback and Microsoft connect action", () => {
    const startConsent = vi.fn();
    mocks.useGraphAuthMock.mockReturnValue({
      connected: false,
      status: "not_connected",
      errorMessage: null,
      loading: false,
      startConsent,
    });
    const page = mountPage("/email?connected=true");

    expect(page.container.textContent).toContain("Microsoft email connected successfully.");

    clickByText(page.container, "Microsoft 365");

    expect(startConsent).toHaveBeenCalledTimes(1);

    page.unmount();
  });

  it("explains Microsoft tenant admin-consent blocks without exposing the raw OAuth code", () => {
    const page = mountPage("/email?error=microsoft_admin_consent_required");

    expect(page.container.textContent).toContain(
      "Your Microsoft 365 admin has blocked user consent for third-party apps."
    );
    expect(page.container.textContent).toContain("Grant admin consent for the T Rock CRM app");
    expect(page.container.textContent).not.toContain("Failed to connect email: microsoft_admin_consent_required");

    page.unmount();
  });

  it("passes the page Graph auth state into the banner", () => {
    const page = mountPage();

    expect(mocks.useGraphAuthMock).toHaveBeenCalled();
    expect(page.container.querySelector('[data-testid="graph-auth-banner"]')?.getAttribute("data-connected")).toBe("false");

    page.unmount();
  });

  it("passes active filters to useUserEmails instead of filtering a paginated page slice", () => {
    const page = mountPage();

    clickByText(page.container, "Unassigned");

    expect(mocks.useUserEmailsMock).toHaveBeenLastCalledWith({
      filter: "unassigned",
      search: undefined,
      page: 1,
      limit: 25,
    });
    expect(page.container.textContent).toContain("Frisco DC re-roof checking timing");
    expect(page.container.textContent).not.toContain("Building A roof phase 2 timeline");

    page.unmount();
  });

  it("uses backend inbox counts rather than the current page slice", () => {
    const page = mountPage();

    expect(page.container.textContent).toContain("Inbox · 11 unread · 9 need attention");
    expect(page.container.textContent).toContain("37");
    expect(page.container.textContent).toContain("14");
    expect(page.container.textContent).toContain("6");

    page.unmount();
  });

  it("shows manual reassignment for standalone emails without conversation IDs", async () => {
    const page = mountPage();

    clickByText(page.container, "Frisco DC re-roof checking timing");
    await clickByTextAsync(page.container, "Reassign email");
    await clickByTextAsync(page.container, "Assign to Dallas ISD");

    expect(mocks.associateEmailToEntityMock).toHaveBeenCalledWith("email-2", mocks.assignTarget);

    page.unmount();
  });

  it("keeps thread tools for emails with conversation IDs", () => {
    const page = mountPage();

    expect(page.container.textContent).toContain("Thread tools");
    expect(page.container.textContent).not.toContain("Reassign email");

    page.unmount();
  });

  it("forward opens compose with forwarded subject and quoted body", () => {
    const page = mountPage();

    clickByText(page.container, "Forward");

    expect(page.container.textContent).toContain("Subject: Fwd: Building A roof phase 2 timeline");
    expect(page.container.textContent).toContain("Forwarded message");
    expect(page.container.textContent).toContain("Confirmed the phasing window");

    page.unmount();
  });

  it("wires reader star archive and delete actions", async () => {
    const page = mountPage();

    await clickByLabelAsync(page.container, "Star");
    await clickByLabelAsync(page.container, "Archive");
    await clickByLabelAsync(page.container, "Delete");

    expect(mocks.updateEmailActionMock).toHaveBeenNthCalledWith(1, "email-1", { isStarred: true });
    expect(mocks.updateEmailActionMock).toHaveBeenNthCalledWith(2, "email-1", { archived: true });
    expect(mocks.updateEmailActionMock).toHaveBeenNthCalledWith(3, "email-1", { deleted: true });

    page.unmount();
  });

  it("selects the reader email from the visible filtered list", () => {
    const page = mountPage();

    clickByText(page.container, "Sent");

    expect(page.container.textContent).toContain("Attached the revised SOV.");
    expect(page.container.textContent).not.toContain("Confirmed the phasing window and bid pricing deadline.");

    page.unmount();
  });

  it("renders Parking Lot Intake as a tab in the inbox tab row", () => {
    const page = mountPage();
    const tabLabels = Array.from(page.container.querySelectorAll("[data-email-filter-tabs] button")).map((button) =>
      button.textContent?.replace(/\s+/g, " ").trim()
    );

    expect(tabLabels.some((label) => label?.includes("Parking Lot Intake"))).toBe(true);

    page.unmount();
  });

  it("Parking Lot Intake tab shows count badge", () => {
    const page = mountPage();
    const tab = Array.from(page.container.querySelectorAll("[data-email-filter-tabs] button")).find((button) =>
      button.textContent?.includes("Parking Lot Intake")
    );

    expect(tab?.textContent).toContain("2");

    page.unmount();
  });

  it("selecting Parking Lot Intake tab shows the intake list", () => {
    const page = mountPage();

    clickByText(page.container, "Parking Lot Intake");

    expect(page.container.textContent).toContain("Vendor invoice needs review");

    page.unmount();
  });

  it("Parking Lot Intake list is no longer rendered as a separate bottom section", () => {
    const page = mountPage();

    expect(page.container.querySelector("[data-parking-lot-bottom-section]")).toBeNull();

    page.unmount();
  });
});
