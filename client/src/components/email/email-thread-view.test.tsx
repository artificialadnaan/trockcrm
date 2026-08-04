import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EmailThreadView } from "./email-thread-view";
import type { EmailThread } from "@/hooks/use-emails";

const useEmailThreadMock = vi.fn();
const useDealsMock = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("dompurify", () => ({
  default: {
    sanitize: (value: string) => value,
  },
}));

vi.mock("@/hooks/use-deals", () => ({
  useDeals: (...args: unknown[]) => useDealsMock(...args),
}));

vi.mock("@/hooks/use-emails", () => ({
  useEmailThread: (...args: unknown[]) => useEmailThreadMock(...args),
  associateEmailToEntity: vi.fn(),
  assignEmailThread: vi.fn(),
  reassignEmailThread: vi.fn(),
  detachEmailThread: vi.fn(),
}));

function buildThread(overrides: Partial<EmailThread> = {}): EmailThread {
  return {
    binding: null,
    preview: null,
    emails: [
      {
        id: "email-1",
        graphMessageId: "graph-1",
        graphConversationId: "conv-1",
        direction: "inbound",
        fromAddress: "customer@example.com",
        toAddresses: ["office@trockgc.com"],
        ccAddresses: [],
        subject: "Need help",
        bodyPreview: "Please call me back",
        bodyHtml: "<p>Please call me back</p>",
        hasAttachments: false,
        contactId: null,
        dealId: null,
        userId: "user-1",
        sentAt: "2026-04-17T18:00:00.000Z",
        syncedAt: "2026-04-17T18:01:00.000Z",
      },
    ],
    ...overrides,
  };
}

describe("EmailThreadView", () => {
  beforeEach(() => {
    useDealsMock.mockReturnValue({ deals: [], loading: false });
  });

  it("renders the unassigned state when there is no bound deal", () => {
    useEmailThreadMock.mockReturnValue({
      thread: buildThread(),
      loading: false,
      error: null,
      setThread: vi.fn(),
    });

    const html = renderToStaticMarkup(
      <EmailThreadView conversationId="conv-1" onBack={() => {}} />
    );

    expect(html).toContain("Thread is not assigned to a deal");
    expect(html).toContain("Assign to Deal");
    expect(html).toContain("Reassign email");
    expect(html).toContain("Need help");
  });

  it("renders the bound-thread state when a deal binding exists", () => {
    useEmailThreadMock.mockReturnValue({
      thread: buildThread({
        binding: {
          id: "binding-1",
          mailboxAccountId: "mailbox-1",
          contactId: "contact-1",
          contactName: "Casey Customer",
          companyId: "company-1",
          companyName: "Alpha Roofing",
          propertyId: null,
          propertyName: null,
          leadId: null,
          leadName: null,
          dealId: "deal-1",
          dealName: "Project Alpha",
          projectId: null,
          projectName: null,
          confidence: "high",
          assignmentReason: "manual_thread_assignment",
        },
      }),
      loading: false,
      error: null,
      setThread: vi.fn(),
    });

    const html = renderToStaticMarkup(
      <EmailThreadView conversationId="conv-1" onBack={() => {}} />
    );

    expect(html).toContain("Bound to deal");
    expect(html).toContain("Project Alpha");
    expect(html).toContain("Reassign");
    expect(html).toContain("Detach");
    expect(html).toContain("Reassign email");
  });

  it("leads the BOUND deal name with 'Change Order N', matching the picker above it", () => {
    // Without this the thread showed the front-loaded name while choosing a deal and then REVERTED
    // to the stored "<Parent> — Change Order N" the moment it was assigned.
    useEmailThreadMock.mockReturnValue({
      thread: buildThread({
        binding: {
          id: "binding-1",
          mailboxAccountId: "mailbox-1",
          contactId: null,
          contactName: null,
          companyId: null,
          companyName: null,
          propertyId: null,
          propertyName: null,
          leadId: null,
          leadName: null,
          dealId: "deal-1",
          dealName: "Tides Park Lane — Change Order 2",
          projectId: null,
          projectName: null,
          confidence: "high",
          assignmentReason: "manual_thread_assignment",
        },
      }),
      loading: false,
      error: null,
      setThread: vi.fn(),
    });

    const html = renderToStaticMarkup(
      <EmailThreadView conversationId="conv-1" onBack={() => {}} />
    );

    expect(html).toContain("Change Order 2 — Tides Park Lane");
    expect(html).not.toContain("Tides Park Lane — Change Order 2");
  });
});
