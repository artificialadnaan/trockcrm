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
}));

vi.mock("@/hooks/use-emails", () => ({
  useUserEmails: mocks.useUserEmailsMock,
}));

vi.mock("@/hooks/use-graph-auth", () => ({
  useGraphAuth: mocks.useGraphAuthMock,
}));

vi.mock("@/components/email/graph-auth-banner", () => ({
  GraphAuthBanner: () => <div data-testid="graph-auth-banner" />,
}));

vi.mock("@/components/email/email-assignment-queue", () => ({
  EmailAssignmentQueue: () => <section>Parking Lot Intake</section>,
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
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSent?: () => void;
    defaultTo?: string;
  }) => (open ? <div role="dialog">Compose open to: {defaultTo ?? "new message"}</div> : null),
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
    contactId: "contact-1",
    dealId: "deal-1",
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
    contactId: null,
    dealId: null,
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
    contactId: "contact-1",
    dealId: "deal-1",
    userId: "user-1",
    sentAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    syncedAt: new Date().toISOString(),
  },
];

function emailsForFilters(filters: EmailFilters = {}) {
  return fixtureEmails.filter((email) => {
    if (filters.direction && email.direction !== filters.direction) return false;
    if (filters.search) {
      const q = filters.search.toLowerCase();
      return [email.subject, email.bodyPreview, email.fromAddress]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(q));
    }
    return true;
  });
}

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

describe("EmailInboxPage", () => {
  beforeEach(() => {
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
      loading: false,
      error: null,
      refetch: vi.fn(),
    }));
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
      direction: "outbound",
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
});
