/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { LeadDueDiligenceQueuePage } from "./lead-due-diligence-queue-page";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  approveLeadDueDiligenceApproval: vi.fn(),
  rejectLeadDueDiligenceApproval: vi.fn(),
  refetch: vi.fn(),
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
  rowsByStatus: {} as Record<string, unknown[]>,
  hookState: {
    loading: false,
    error: null as string | null,
  },
  useLeadDueDiligenceApprovals: vi.fn((status = "pending") => ({
    approvals: mocks.rowsByStatus[status] ?? [],
    loading: mocks.hookState.loading,
    error: mocks.hookState.error,
    refetch: mocks.refetch,
  })),
}));

vi.mock("sonner", () => ({
  toast: mocks.toast,
}));

vi.mock("@/hooks/use-lead-due-diligence", () => ({
  approveLeadDueDiligenceApproval: mocks.approveLeadDueDiligenceApproval,
  rejectLeadDueDiligenceApproval: mocks.rejectLeadDueDiligenceApproval,
  useLeadDueDiligenceApprovals: mocks.useLeadDueDiligenceApprovals,
}));

let container: HTMLDivElement;
let root: Root;

const baseApproval = {
  id: "approval-1",
  lead_id: "lead-1",
  status: "pending",
  requested_at: "2026-05-01T12:00:00.000Z",
  decided_at: null,
  decision_reason: null,
  detection_signal: {
    detail: "No recent activity found",
    occurred_at: null,
  },
  email_sent_at: null,
  email_message_id: null,
  lead_name: "Lead Alpha",
  company_name: "Acme HOA",
  company_verification_status: "pending",
  primary_contact_name: "Taylor Contact",
  primary_contact_email: "taylor@example.com",
  primary_contact_role: "property_manager",
  primary_contact_role_other_label: null,
  property_address: "123 Main St",
  property_city: "Dallas",
  property_state: "TX",
  property_zip: "75201",
  unit_count: 120,
  build_year: 1998,
  project_type_name: "Exterior Renovation",
  budget_status: "budgeted_q1",
  bid_due_date: "2026-06-01",
  requested_by_name: "Admin User",
  decided_by_name: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hookState.loading = false;
  mocks.hookState.error = null;
  mocks.rowsByStatus = {
    pending: [baseApproval],
    approved: [
      {
        ...baseApproval,
        id: "approval-2",
        lead_name: "Approved Lead",
        status: "approved",
        decided_at: "2026-05-02T13:00:00.000Z",
        decided_by_name: "Director User",
      },
    ],
    rejected: [
      {
        ...baseApproval,
        id: "approval-3",
        lead_name: "Rejected Lead",
        status: "rejected",
        decision_reason: "Not enough verified customer history.",
        decided_at: "2026-05-03T14:00:00.000Z",
        decided_by_name: null,
        detection_signal: {
          detail: "Recent deal activity on company",
          occurred_at: "2026-04-25T09:30:00.000Z",
        },
      },
    ],
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

async function renderPage() {
  await act(async () => {
    root.render(<LeadDueDiligenceQueuePage />);
  });
}

function buttonByText(text: string) {
  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
  return (
    buttons.find((button) => button.textContent?.trim() === text) ??
    buttons.find((button) => button.textContent?.includes(text))
  );
}

function exactButtonByText(text: string) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.trim() === text);
}

async function clickButton(text: string) {
  const button = buttonByText(text);
  expect(button).toBeTruthy();
  await act(async () => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function setTextareaValue(value: string) {
  const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
  expect(textarea).toBeTruthy();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(textarea, value);
    textarea!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("LeadDueDiligenceQueuePage", () => {
  it("renders pending approvals by default", async () => {
    await renderPage();

    expect(mocks.useLeadDueDiligenceApprovals).toHaveBeenLastCalledWith("pending");
    expect(container.textContent).toContain("Pending (1)");
    expect(container.textContent).toContain("Lead Alpha");
    expect(container.textContent).toContain("Property Manager");
    expect(container.textContent).toContain("Budgeted Q1");
  });

  it("fetches and renders approved approvals from the approved tab", async () => {
    await renderPage();
    await clickButton("Approved");

    expect(mocks.useLeadDueDiligenceApprovals).toHaveBeenLastCalledWith("approved");
    expect(container.textContent).toContain("Approved (1)");
    expect(container.textContent).toContain("Approved Lead");
    expect(container.textContent).toContain("Decided by Director User");
    expect(exactButtonByText("Approve")).toBeUndefined();
  });

  it("fetches and renders rejected approvals from the rejected tab", async () => {
    await renderPage();
    await clickButton("Rejected");

    expect(mocks.useLeadDueDiligenceApprovals).toHaveBeenLastCalledWith("rejected");
    expect(container.textContent).toContain("Rejected (1)");
    expect(container.textContent).toContain("Rejected Lead");
    expect(container.textContent).toContain("Not enough verified customer history.");
  });

  it("renders the empty state", async () => {
    mocks.rowsByStatus.pending = [];

    await renderPage();

    expect(container.textContent).toContain("No pending Due Diligence approvals.");
  });

  it("renders the loading state", async () => {
    mocks.hookState.loading = true;

    await renderPage();

    expect(container.textContent).toContain("Loading approvals");
  });

  it("renders the error state", async () => {
    mocks.hookState.error = "Failed to load";

    await renderPage();

    expect(container.textContent).toContain("Failed to load");
  });

  it("approves and refetches on success", async () => {
    mocks.approveLeadDueDiligenceApproval.mockResolvedValueOnce({ approval: { id: "approval-1" } });

    await renderPage();
    await clickButton("Approve");

    expect(mocks.approveLeadDueDiligenceApproval).toHaveBeenCalledWith("approval-1");
    expect(mocks.toast.success).toHaveBeenCalledWith("Due Diligence approved");
    expect(mocks.refetch).toHaveBeenCalled();
  });

  it("reveals the rejection reason textarea", async () => {
    await renderPage();
    await clickButton("Reject");

    expect(container.querySelector("textarea")).toBeTruthy();
    expect(container.textContent).toContain("Rejection reason");
  });

  it("does not submit a short rejection reason", async () => {
    await renderPage();
    await clickButton("Reject");

    await setTextareaValue("short");
    await clickButton("Confirm Reject");

    expect(mocks.rejectLeadDueDiligenceApproval).not.toHaveBeenCalled();
    expect(mocks.toast.error).toHaveBeenCalledWith("Rejection reason must be at least 10 characters");
  });

  it("rejects with a valid reason and refetches", async () => {
    mocks.rejectLeadDueDiligenceApproval.mockResolvedValueOnce({ approval: { id: "approval-1" } });
    await renderPage();
    await clickButton("Reject");

    await setTextareaValue("This company should not qualify.");
    await clickButton("Confirm Reject");

    expect(mocks.rejectLeadDueDiligenceApproval).toHaveBeenCalledWith(
      "approval-1",
      "This company should not qualify."
    );
    expect(mocks.toast.success).toHaveBeenCalledWith("Due Diligence rejected");
    expect(mocks.refetch).toHaveBeenCalled();
  });

  it("warns and refetches when approval has already been decided", async () => {
    mocks.approveLeadDueDiligenceApproval.mockRejectedValueOnce(new ApiError(409, { message: "Already decided" }));

    await renderPage();
    await clickButton("Approve");

    expect(mocks.toast.warning).toHaveBeenCalledWith("This approval was already decided. Refreshing...");
    expect(mocks.refetch).toHaveBeenCalled();
  });

  it("shows decided rows with a named decider", async () => {
    await renderPage();
    await clickButton("Approved");

    expect(container.textContent).toContain("Decided by Director User");
  });

  it("shows token-decided rows when decided_by is null", async () => {
    await renderPage();
    await clickButton("Rejected");

    expect(container.textContent).toContain("Decided via email token");
  });
});
