/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketingExpenseRequestSummary } from "@trock-crm/shared/types";
import { MyMarketingExpenseRequestsPage } from "./my-marketing-expense-requests-page";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  useMyMarketingExpenseRequests: vi.fn(),
  withdrawMarketingExpenseRequest: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("react-router-dom", () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("@/hooks/use-marketing-expense-requests", () => ({
  useMyMarketingExpenseRequests: mocks.useMyMarketingExpenseRequests,
  withdrawMarketingExpenseRequest: mocks.withdrawMarketingExpenseRequest,
}));

let container: HTMLDivElement;
let root: Root;

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

function state(overrides: Record<string, unknown> = {}) {
  return {
    requests: [] as MarketingExpenseRequestSummary[],
    loading: false,
    error: null,
    refetch: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useMyMarketingExpenseRequests.mockReturnValue(state());
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
    root.render(<MyMarketingExpenseRequestsPage />);
  });
}

describe("empty state", () => {
  it("says there is nothing yet, and offers the way to make one", async () => {
    await renderPage();
    expect(container.textContent).toContain("You have not submitted any expense requests yet");
    const link = container.querySelector<HTMLAnchorElement>('[data-testid="mer-new-request"]');
    expect(link?.getAttribute("href")).toBe("/marketing-expense-requests/new");
  });
});

describe("loading and error", () => {
  it("announces loading to a screen reader, not just as grey boxes", async () => {
    mocks.useMyMarketingExpenseRequests.mockReturnValue(state({ loading: true }));
    await renderPage();
    expect(container.querySelector(".sr-only")?.textContent).toContain("Loading");
  });

  it("renders a load failure as an alert", async () => {
    mocks.useMyMarketingExpenseRequests.mockReturnValue(state({ error: "Network is down" }));
    await renderPage();
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Network is down");
  });
});

describe("the list", () => {
  it("shows the request number, event, total and status", async () => {
    mocks.useMyMarketingExpenseRequests.mockReturnValue(state({ requests: [summary()] }));
    await renderPage();
    const row = container.querySelector('[data-testid="mer-row-req-1"]')!;
    expect(row.textContent).toContain("MER-0001");
    expect(row.textContent).toContain("Multifamily Expo");
    expect(row.textContent).toContain("$4,250.00");
    expect(row.textContent).toContain("Awaiting approval");
  });

  it("labels every status a request can be in", async () => {
    mocks.useMyMarketingExpenseRequests.mockReturnValue(
      state({
        requests: [
          summary({ id: "a", status: "draft" }),
          summary({ id: "b", status: "pending" }),
          summary({ id: "c", status: "approved" }),
          summary({ id: "d", status: "denied" }),
          summary({ id: "e", status: "withdrawn" }),
        ],
      }),
    );
    await renderPage();
    for (const [id, label] of [
      ["a", "Draft"],
      ["b", "Awaiting approval"],
      ["c", "Approved"],
      ["d", "Denied"],
      ["e", "Withdrawn"],
    ]) {
      expect(container.querySelector(`[data-testid="mer-row-${id}"]`)?.textContent).toContain(label);
    }
  });

  it("shows the deadline on the day it was set, not the day before", async () => {
    // neededBy is a Postgres `date` ("2026-10-01"). Rendering it through `new Date(...)` makes it midnight
    // UTC, which `toLocaleDateString()` shows as 30 September in Dallas — a deadline a day early.
    mocks.useMyMarketingExpenseRequests.mockReturnValue(state({ requests: [summary()] }));
    await renderPage();
    const expected = new Date(2026, 9, 1).toLocaleDateString();
    expect(container.querySelector('[data-testid="mer-row-req-1"]')!.textContent).toContain(expected);
  });

  it("shows the DENIAL REASON, which is the only part of a denial that helps", async () => {
    mocks.useMyMarketingExpenseRequests.mockReturnValue(
      state({
        requests: [
          summary({ status: "denied", latestDecision: "denied", latestDecisionReason: "Over budget for Q4" }),
        ],
      }),
    );
    await renderPage();
    expect(container.textContent).toContain("Over budget for Q4");
  });

  it("counts what is outstanding and what landed", async () => {
    mocks.useMyMarketingExpenseRequests.mockReturnValue(
      state({
        requests: [
          summary({ id: "a", status: "pending" }),
          summary({ id: "b", status: "pending" }),
          summary({ id: "c", status: "approved" }),
          summary({ id: "d", status: "denied" }),
        ],
      }),
    );
    await renderPage();
    expect(container.querySelector('[data-testid="mer-stat-pending"]')?.textContent).toBe("2");
    expect(container.querySelector('[data-testid="mer-stat-approved"]')?.textContent).toBe("1");
    expect(container.querySelector('[data-testid="mer-stat-denied"]')?.textContent).toBe("1");
  });
});

describe("withdrawing", () => {
  it("offers withdraw only while a request is still pending", async () => {
    mocks.useMyMarketingExpenseRequests.mockReturnValue(
      state({
        requests: [
          summary({ id: "a", status: "pending" }),
          summary({ id: "b", status: "approved" }),
          summary({ id: "c", status: "draft" }),
        ],
      }),
    );
    await renderPage();
    expect(container.querySelector('[data-testid="mer-withdraw-a"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="mer-withdraw-b"]')).toBeNull();
    expect(container.querySelector('[data-testid="mer-withdraw-c"]')).toBeNull();
  });

  it("withdraws and refetches", async () => {
    const refetch = vi.fn();
    mocks.withdrawMarketingExpenseRequest.mockResolvedValue({ id: "req-1" });
    mocks.useMyMarketingExpenseRequests.mockReturnValue(state({ requests: [summary()], refetch }));
    await renderPage();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="mer-withdraw-req-1"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mocks.withdrawMarketingExpenseRequest).toHaveBeenCalledWith("req-1");
    expect(refetch).toHaveBeenCalled();
  });

  it("re-reads the list when the withdraw loses a race with a decision", async () => {
    const refetch = vi.fn();
    mocks.withdrawMarketingExpenseRequest.mockRejectedValue(
      Object.assign(new Error("Only a pending request can be withdrawn."), { status: 409 }),
    );
    mocks.useMyMarketingExpenseRequests.mockReturnValue(state({ requests: [summary()], refetch }));
    await renderPage();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="mer-withdraw-req-1"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(refetch).toHaveBeenCalled();
    expect(mocks.toast.error).toHaveBeenCalled();
  });
});
