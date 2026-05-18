// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EmailAssignmentQueueView, type EmailAssignmentQueueItem } from "./email-assignment-queue-view";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function baseQueueItem(overrides: Partial<EmailAssignmentQueueItem> = {}): EmailAssignmentQueueItem {
  return {
    email: {
      id: "email-1",
      subject: "Question about TR-2026-0002",
      bodyPreview: "Need help with the right job",
      fromAddress: "customer@example.com",
      sentAt: "2026-04-15T14:00:00.000Z",
    },
    companyId: "company-1",
    contactName: "Casey Customer",
    companyName: "Alpha Roofing",
    candidateDeals: [],
    candidateLeads: [],
    candidateProperties: [],
    suggestedAssignment: {
      assignedEntityType: "company",
      assignedEntityId: "company-1",
      assignedDealId: null,
      confidence: "low",
      ambiguityReason: "company_only_fallback",
      matchedBy: "company_only",
      requiresClassificationTask: true,
      candidateDealIds: [],
    },
    ...overrides,
  };
}

async function renderQueueView(element: ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(element);
  });

  return {
    container,
    button(label: string) {
      const match = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes(label)
      );
      if (!match) throw new Error(`Button not found: ${label}`);
      return match as HTMLButtonElement;
    },
    async cleanup() {
      await act(async () => {
        root?.unmount();
      });
      container.remove();
    },
  };
}

describe("EmailAssignmentQueueView", () => {
  it("renders parking-lot intake details with broader CRM target options", () => {
    const html = renderToStaticMarkup(
      <EmailAssignmentQueueView
        items={[
          {
            email: {
              id: "email-1",
              subject: "Question about TR-2026-0002",
              bodyPreview: "Need help with the right job",
              fromAddress: "customer@example.com",
              sentAt: "2026-04-15T14:00:00.000Z",
            },
            companyId: "company-1",
            contactName: "Casey Customer",
            companyName: "Alpha Roofing",
            candidateDeals: [
              { id: "deal-1", dealNumber: "TR-2026-0001", name: "Alpha Roof" },
              { id: "deal-2", dealNumber: "TR-2026-0002", name: "Beta Roof" },
            ],
            candidateLeads: [
              { id: "lead-1", leadNumber: "TR-2026-L001", name: "Alpha Lead", relatedDealId: "deal-1" },
            ],
            candidateProperties: [
              { id: "property-1", name: "123 Main St", relatedDealIds: ["deal-1"] },
            ],
            suggestedAssignment: {
              assignedEntityType: "company",
              assignedEntityId: "company-1",
              assignedDealId: null,
              confidence: "low",
              ambiguityReason: "multiple_deal_candidates",
              matchedBy: "company_only",
              requiresClassificationTask: true,
              candidateDealIds: ["deal-1", "deal-2"],
            },
          },
        ]}
        onAssign={async () => ({ ok: true })}
        onIgnore={async () => ({ ok: true })}
      />
    );

    expect(html).toContain("Casey Customer");
    expect(html).toContain("Question about TR-2026-0002");
    expect(html).toContain("Assign manually");
    expect(html).toContain("Ignore");
    expect(html).toContain("4 safe suggestions available");
    expect(html).toContain("multiple_deal_candidates");
    expect(html).toContain("Open manual assignment to use a suggestion or search anywhere in the CRM.");
    expect(html).toContain("Alpha Roofing");
    expect(html).toContain("Parking lot");
  });

  it("renders a manual assignment action when there are no safe suggestions", () => {
    const html = renderToStaticMarkup(
      <EmailAssignmentQueueView
        items={[
          {
            email: {
              id: "email-2",
              subject: "Receipt",
              bodyPreview: "Please keep this mail for your records.",
              fromAddress: "homedepot@order.homedepot.com",
              sentAt: "2026-04-20T19:03:34.000Z",
            },
            companyId: null,
            contactName: null,
            companyName: null,
            candidateDeals: [],
            candidateLeads: [],
            candidateProperties: [],
            candidateCompanies: [],
            suggestedAssignment: {
              assignedEntityType: null,
              assignedEntityId: null,
              assignedDealId: null,
              confidence: "low",
              ambiguityReason: "no_company_context",
              matchedBy: "company_only",
              requiresClassificationTask: true,
              candidateDealIds: [],
            },
          },
        ]}
        onAssign={async () => ({ ok: true })}
        onIgnore={async () => ({ ok: true })}
      />
    );

    expect(html).toContain("No safe match found");
    expect(html).toContain("Assign manually");
    expect(html).toContain("Ignore");
    expect(html).not.toContain("No safe assignment targets");
  });

  it("offers a company-only suggestion even when the company name is unavailable", () => {
    const html = renderToStaticMarkup(
      <EmailAssignmentQueueView
        items={[
          {
            email: {
              id: "email-company",
              subject: "General question",
              bodyPreview: "Can you help route this?",
              fromAddress: "buyer@example.com",
              sentAt: "2026-04-20T19:03:34.000Z",
            },
            companyId: "company-1",
            contactName: null,
            companyName: null,
            candidateDeals: [],
            candidateLeads: [],
            candidateProperties: [],
            candidateCompanies: [],
            suggestedAssignment: {
              assignedEntityType: "company",
              assignedEntityId: "company-1",
              assignedDealId: null,
              confidence: "low",
              ambiguityReason: "company_only_fallback",
              matchedBy: "company_only",
              requiresClassificationTask: true,
              candidateDealIds: [],
            },
          },
        ]}
        onAssign={async () => ({ ok: true })}
        onIgnore={async () => ({ ok: true })}
      />
    );

    expect(html).toContain("1 safe suggestion available");
    expect(html).not.toContain("No safe match found");
  });

  it("renders an empty-state message when there are no items", () => {
    const html = renderToStaticMarkup(
      <EmailAssignmentQueueView items={[]} onAssign={async () => ({ ok: true })} onIgnore={async () => ({ ok: true })} />
    );
    expect(html).toContain("No unresolved parking-lot email intake.");
  });

  it("renders ignored empty state copy separately from parking lot copy", () => {
    const html = renderToStaticMarkup(
      <EmailAssignmentQueueView
        status="ignored"
        items={[]}
        onAssign={async () => ({ ok: true })}
        onIgnore={async () => ({ ok: true })}
      />
    );
    expect(html).toContain("No ignored email intake.");
  });

  it("renders an unignore action for ignored emails", () => {
    const html = renderToStaticMarkup(
      <EmailAssignmentQueueView
        status="ignored"
        items={[
          {
            email: {
              id: "email-3",
              subject: "Newsletter",
              bodyPreview: "Weekly update",
              fromAddress: "news@example.com",
              sentAt: "2026-04-21T12:00:00.000Z",
            },
            companyId: null,
            contactName: null,
            companyName: null,
            candidateDeals: [],
            candidateLeads: [],
            candidateProperties: [],
            suggestedAssignment: {
              assignedEntityType: null,
              assignedEntityId: null,
              assignedDealId: null,
              confidence: "low",
              ambiguityReason: "no_company_context",
              matchedBy: "company_only",
              requiresClassificationTask: true,
              candidateDealIds: [],
            },
          },
        ]}
        onAssign={async () => ({ ok: true })}
        onIgnore={async () => ({ ok: true })}
        onUnignore={async () => ({ ok: true })}
      />
    );

    expect(html).toContain("Unignore");
    expect(html).toContain("Ignored email");
    expect(html).not.toContain(">Ignore<");
  });

  it("calls the ignore handler when the parking-lot Ignore action is clicked", async () => {
    const onIgnore = vi.fn(async () => ({ ok: true as const }));
    const view = await renderQueueView(
      <EmailAssignmentQueueView
        items={[baseQueueItem()]}
        onAssign={async () => ({ ok: true })}
        onIgnore={onIgnore}
      />
    );

    await act(async () => {
      view.button("Ignore").click();
    });

    expect(onIgnore).toHaveBeenCalledWith("email-1");
    await view.cleanup();
  });

  it("calls the unignore handler when the ignored Unignore action is clicked", async () => {
    const onUnignore = vi.fn(async () => ({ ok: true as const }));
    const view = await renderQueueView(
      <EmailAssignmentQueueView
        status="ignored"
        items={[baseQueueItem({ email: { ...baseQueueItem().email, id: "email-ignored" } })]}
        onAssign={async () => ({ ok: true })}
        onIgnore={async () => ({ ok: true })}
        onUnignore={onUnignore}
      />
    );

    await act(async () => {
      view.button("Unignore").click();
    });

    expect(onUnignore).toHaveBeenCalledWith("email-ignored");
    await view.cleanup();
  });
});
