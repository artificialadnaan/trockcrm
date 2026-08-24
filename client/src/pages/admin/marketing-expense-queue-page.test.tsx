/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketingExpenseRequestSummary } from "@trock-crm/shared/types";
import { MarketingExpenseQueuePage } from "./marketing-expense-queue-page";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  useMarketingExpenseQueue: vi.fn(),
  decideMarketingExpenseRequest: vi.fn(),
  getMarketingExpenseRequest: vi.fn(),
  downloadFile: vi.fn(),
  isApiError: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/lib/api", () => ({ isApiError: mocks.isApiError }));
vi.mock("@/hooks/use-files", () => ({ downloadFile: mocks.downloadFile }));
vi.mock("@/hooks/use-marketing-expense-requests", () => ({
  useMarketingExpenseQueue: mocks.useMarketingExpenseQueue,
  decideMarketingExpenseRequest: mocks.decideMarketingExpenseRequest,
  getMarketingExpenseRequest: mocks.getMarketingExpenseRequest,
}));

let container: HTMLDivElement;
let root: Root;
let refetch: ReturnType<typeof vi.fn>;

function summary(overrides: Partial<MarketingExpenseRequestSummary> = {}): MarketingExpenseRequestSummary {
  return {
    id: "req-1",
    requestNumber: "MER-0001",
    status: "pending",
    vendorEvent: "Multifamily Expo",
    neededBy: "2026-10-01",
    totalRequested: "4250.00",
    submittedAt: "2026-08-20T12:00:00.000Z",
    createdAt: "2026-08-20T11:00:00.000Z",
    submittedByName: "Reggie Rep",
    latestDecision: null,
    latestDecisionReason: null,
    latestDecidedByName: null,
    latestDecidedAt: null,
    ...overrides,
  };
}

function detail(overrides: Record<string, unknown> = {}) {
  return {
    ...summary(),
    submittedBy: "user-1",
    requestedByName: "Reggie Rep",
    department: "Sales",
    locationDates: "Dallas, Oct 12-14",
    purpose: "Booth at the regional expo to meet property managers",
    expectedReturn: "Qualified leads from property managers",
    costAdvertising: "1000.00",
    costRegistration: "2500.50",
    costTravel: "500.00",
    costLodging: "249.50",
    costMeals: "0.00",
    costMaterials: "0.00",
    costOther1: "0.00",
    costOther1Label: null,
    costOther2: "0.00",
    costOther2Label: null,
    budgetJobCode: "MKT-2026",
    travelRequired: true,
    attendees: "Reggie Rep",
    businessMeetings: "Greystar",
    paymentMethod: "company_card",
    attachmentKinds: ["quote_proposal"],
    stepsRequired: 1,
    approvals: [],
    attachments: [{ id: "file-1", displayName: "expo-quote.pdf", fileSizeBytes: 4096, createdAt: "2026-08-20T12:00:00.000Z" }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getMarketingExpenseRequest.mockResolvedValue(detail());
  refetch = vi.fn();
  mocks.isApiError.mockReturnValue(false);
  mocks.decideMarketingExpenseRequest.mockResolvedValue({ id: "req-1" });
  mocks.useMarketingExpenseQueue.mockReturnValue({
    requests: [summary()],
    loading: false,
    error: null,
    refetch,
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  container.remove();
});

async function renderPage() {
  await act(async () => {
    root.render(<MarketingExpenseQueuePage />);
  });
}

async function click(testId: string) {
  const element = container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!element) throw new Error(`no element with data-testid="${testId}"`);
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function typeReason(value: string) {
  const textarea = container.querySelector<HTMLTextAreaElement>('[data-testid="mer-deny-reason"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("tabs", () => {
  it("opens on Pending — the only tab with anything to do", async () => {
    await renderPage();
    expect(mocks.useMarketingExpenseQueue).toHaveBeenCalledWith("pending");
  });

  it("shows a count on the ACTIVE tab only, so it can never claim a stale number for a tab it has not loaded", async () => {
    await renderPage();
    expect(container.querySelector('[data-testid="mer-tab-pending"]')?.textContent).toContain("(1)");
    expect(container.querySelector('[data-testid="mer-tab-approved"]')?.textContent).not.toContain("(");
  });

  it("refetches against the new status when a tab is picked", async () => {
    await renderPage();
    await click("mer-tab-denied");
    expect(mocks.useMarketingExpenseQueue).toHaveBeenLastCalledWith("denied");
  });
});

describe("the row", () => {
  it("shows who asked, for what, and how much", async () => {
    await renderPage();
    const row = container.querySelector('[data-testid="mer-queue-row-req-1"]')!;
    expect(row.textContent).toContain("MER-0001");
    expect(row.textContent).toContain("Reggie Rep");
    expect(row.textContent).toContain("Multifamily Expo");
    expect(row.textContent).toContain("$4,250.00");
  });

  it("offers approve and deny only on the pending tab", async () => {
    await renderPage();
    await click("mer-review-req-1");
    expect(container.querySelector('[data-testid="mer-approve-req-1"]')).toBeTruthy();
    await click("mer-tab-approved");
    expect(container.querySelector('[data-testid="mer-approve-req-1"]')).toBeNull();
  });

  it("renders an empty tab as an empty state, not as a blank page", async () => {
    mocks.useMarketingExpenseQueue.mockReturnValue({
      requests: [],
      loading: false,
      error: null,
      refetch,
    });
    await renderPage();
    expect(container.textContent).toContain("No pending expense requests");
  });
});

describe("approving", () => {
  it("decides and refetches", async () => {
    await renderPage();
    await click("mer-review-req-1");
    await click("mer-approve-req-1");
    expect(mocks.decideMarketingExpenseRequest).toHaveBeenCalledWith("req-1", "approved");
    expect(refetch).toHaveBeenCalled();
  });

  it("toasts and REFETCHES on a 409 — two approvers clicking at once is the normal case", async () => {
    mocks.isApiError.mockReturnValue(true);
    mocks.decideMarketingExpenseRequest.mockRejectedValue(
      Object.assign(new Error("already decided"), { status: 409 }),
    );
    await renderPage();
    await click("mer-review-req-1");
    await click("mer-approve-req-1");
    expect(mocks.toast.warning).toHaveBeenCalled();
    expect(refetch).toHaveBeenCalled();
  });

  it("does NOT refetch on an ordinary failure — re-reading would hide the error", async () => {
    mocks.isApiError.mockReturnValue(true);
    mocks.decideMarketingExpenseRequest.mockRejectedValue(
      Object.assign(new Error("boom"), { status: 500 }),
    );
    await renderPage();
    await click("mer-review-req-1");
    await click("mer-approve-req-1");
    expect(mocks.toast.error).toHaveBeenCalled();
    expect(refetch).not.toHaveBeenCalled();
  });
});

describe("denying", () => {
  it("requires a reason before it will send anything", async () => {
    await renderPage();
    await click("mer-review-req-1");
    await click("mer-deny-req-1");
    await typeReason("short");
    await click("mer-confirm-deny-req-1");
    expect(mocks.decideMarketingExpenseRequest).not.toHaveBeenCalled();
    expect(mocks.toast.error).toHaveBeenCalled();
  });

  it("sends the reason with the denial", async () => {
    await renderPage();
    await click("mer-review-req-1");
    await click("mer-deny-req-1");
    await typeReason("This is over the quarterly marketing budget");
    await click("mer-confirm-deny-req-1");
    expect(mocks.decideMarketingExpenseRequest).toHaveBeenCalledWith(
      "req-1",
      "denied",
      "This is over the quarterly marketing budget",
    );
    expect(refetch).toHaveBeenCalled();
  });

  it("clears the open reason box on a 409 rather than leaving it over a row that has moved on", async () => {
    mocks.isApiError.mockReturnValue(true);
    mocks.decideMarketingExpenseRequest.mockRejectedValue(
      Object.assign(new Error("already decided"), { status: 409 }),
    );
    await renderPage();
    await click("mer-review-req-1");
    await click("mer-deny-req-1");
    await typeReason("This is over the quarterly marketing budget");
    await click("mer-confirm-deny-req-1");
    expect(container.querySelector('[data-testid="mer-deny-reason"]')).toBeNull();
    expect(refetch).toHaveBeenCalled();
  });
});

describe("reviewing before deciding", () => {
  it("does NOT offer a decision from the summary row alone", async () => {
    // The whole point of this form is "what is this for, and what does TRC get back". Approving from a row
    // is approving a number attached to a name.
    await renderPage();
    expect(container.querySelector('[data-testid="mer-approve-req-1"]')).toBeNull();
    expect(container.querySelector('[data-testid="mer-deny-req-1"]')).toBeNull();
    expect(container.querySelector('[data-testid="mer-review-req-1"]')).toBeTruthy();
  });

  it("loads the full request when the approver opens it", async () => {
    await renderPage();
    await click("mer-review-req-1");
    expect(mocks.getMarketingExpenseRequest).toHaveBeenCalledWith("req-1");
  });

  it("shows the narrative the decision is supposed to rest on", async () => {
    await renderPage();
    await click("mer-review-req-1");
    const panel = container.querySelector('[data-testid="mer-detail-req-1"]')!;
    expect(panel.textContent).toContain("Booth at the regional expo");
    expect(panel.textContent).toContain("Qualified leads from property managers");
  });

  it("shows the cost breakdown, not just the total", async () => {
    await renderPage();
    await click("mer-review-req-1");
    const panel = container.querySelector('[data-testid="mer-detail-req-1"]')!;
    expect(panel.textContent).toContain("$1,000.00");
    expect(panel.textContent).toContain("$2,500.50");
    expect(panel.textContent).toContain("$249.50");
  });

  it("lists the supporting attachments", async () => {
    await renderPage();
    await click("mer-review-req-1");
    expect(container.querySelector('[data-testid="mer-detail-req-1"]')!.textContent).toContain(
      "expo-quote.pdf",
    );
  });

  it("makes each supporting document OPENABLE, not just visible", async () => {
    // Seeing that a quote exists is not reading it. The decision is supposed to rest on the contents.
    await renderPage();
    await click("mer-review-req-1");
    await click("mer-attachment-file-1");
    expect(mocks.downloadFile).toHaveBeenCalledWith("file-1");
  });

  it("says so when a request has no attachments at all", async () => {
    mocks.getMarketingExpenseRequest.mockResolvedValue(detail({ attachments: [] }));
    await renderPage();
    await click("mer-review-req-1");
    expect(container.querySelector('[data-testid="mer-detail-req-1"]')!.textContent).toContain(
      "No supporting documents",
    );
  });

  it("enables the decision only once the request is on screen", async () => {
    await renderPage();
    await click("mer-review-req-1");
    expect(container.querySelector('[data-testid="mer-approve-req-1"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="mer-deny-req-1"]')).toBeTruthy();
  });

  it("keeps the decision unavailable when the detail fails to load", async () => {
    mocks.getMarketingExpenseRequest.mockRejectedValue(new Error("network died"));
    await renderPage();
    await click("mer-review-req-1");
    expect(container.querySelector('[data-testid="mer-approve-req-1"]')).toBeNull();
    expect(mocks.toast.error).toHaveBeenCalled();
  });

  it("shows the deadline on the calendar day it was set, not the day before", async () => {
    await renderPage();
    // neededBy is "2026-10-01", a date-only column. Rendering it through a UTC instant shows 9/30 in Dallas.
    const expected = new Date(2026, 9, 1).toLocaleDateString();
    expect(container.querySelector('[data-testid="mer-queue-row-req-1"]')!.textContent).toContain(expected);
  });
});

describe("the denial reason belongs to one request", () => {
  function twoRequests() {
    mocks.useMarketingExpenseQueue.mockReturnValue({
      requests: [summary(), summary({ id: "req-2", requestNumber: "MER-0002" })],
      loading: false,
      error: null,
      refetch,
    });
  }

  it("does not carry a reason typed for one request over to another", async () => {
    twoRequests();
    await renderPage();
    await click("mer-review-req-1");
    await click("mer-deny-req-1");
    await typeReason("This one is over the quarterly budget");

    mocks.getMarketingExpenseRequest.mockResolvedValue(detail({ id: "req-2" }));
    await click("mer-review-req-2");
    await click("mer-deny-req-2");
    const textarea = container.querySelector<HTMLTextAreaElement>('[data-testid="mer-deny-reason"]')!;
    expect(textarea.value).toBe("");
  });

  it("cannot deny request B with the text typed for request A", async () => {
    twoRequests();
    await renderPage();
    await click("mer-review-req-1");
    await click("mer-deny-req-1");
    await typeReason("This one is over the quarterly budget");

    mocks.getMarketingExpenseRequest.mockResolvedValue(detail({ id: "req-2" }));
    await click("mer-review-req-2");
    await click("mer-deny-req-2");
    await click("mer-confirm-deny-req-2");
    expect(mocks.decideMarketingExpenseRequest).not.toHaveBeenCalled();
    expect(mocks.toast.error).toHaveBeenCalled();
  });
});
