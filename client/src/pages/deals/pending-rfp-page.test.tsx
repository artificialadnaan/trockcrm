// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { PendingRfpPage } from "./pending-rfp-page";

const mocks = vi.hoisted(() => ({
  usePendingRfpMock: vi.fn(),
}));

vi.mock("@/hooks/use-deals", () => ({
  usePendingRfp: mocks.usePendingRfpMock,
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  CardContent: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  CardHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, className }: { children: ReactNode; className?: string }) => (
    <span className={className}>{children}</span>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    ...props
  }: { children: ReactNode } & Record<string, unknown>) => (
    <button {...props}>{children}</button>
  ),
}));

// A stale deal triggered 30 days ago — always >= PENDING_RFP_STALE_DAYS (2)
const STALE_TRIGGERED_AT = "2024-01-01T00:00:00.000Z";
// A fresh deal triggered right now — 0 days old, never stale
const FRESH_TRIGGERED_AT = new Date().toISOString();

const FIXTURE_DEALS = [
  {
    id: "deal-stale-111",
    name: "Sunset Ridge Apartments",
    projectNumber: "DFW-0042",
    dealNumber: "12345",
    workflowRoute: "normal",
    assignedRepId: "rep-1",
    assignedRepName: "Jordan Smith",
    rfpApprovalStatus: "pending",
    subState: "awaiting" as const,
    triggeredById: "rep-1",
    triggeredByName: "Jordan Smith",
    triggeredAt: STALE_TRIGGERED_AT,
    reason: null,
  },
  {
    id: "deal-fresh-222",
    name: "Riverside Commons Phase 2",
    projectNumber: null,
    dealNumber: "67890",
    workflowRoute: "service",
    assignedRepId: "rep-2",
    assignedRepName: "Alex Johnson",
    rfpApprovalStatus: "declined",
    subState: "attention" as const,
    triggeredById: "rep-2",
    triggeredByName: "Alex Johnson",
    triggeredAt: FRESH_TRIGGERED_AT,
    reason: "Price too high",
  },
];

function renderRoute(container: HTMLElement, path = "/deals/pending-rfp") {
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/deals/pending-rfp" element={<PendingRfpPage />} />
        </Routes>
      </MemoryRouter>
    );
  });
  return root;
}

describe("PendingRfpPage", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.innerHTML = "";
    document.body.appendChild(container);
    root = null;
    mocks.usePendingRfpMock.mockReset();
    mocks.usePendingRfpMock.mockReturnValue({
      deals: null,
      loading: true,
      error: null,
      refetch: vi.fn(),
    });
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container.remove();
  });

  it("renders the page heading and loading state", () => {
    root = renderRoute(container);
    expect(container.textContent).toContain("Pending RFP");
    expect(container.textContent).toContain("Loading");
  });

  it("renders both deal names and rep names when data is loaded", () => {
    mocks.usePendingRfpMock.mockReturnValue({
      deals: FIXTURE_DEALS,
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    root = renderRoute(container);

    expect(container.textContent).toContain("Pending RFP");
    expect(container.textContent).toContain("Sunset Ridge Apartments");
    expect(container.textContent).toContain("Riverside Commons Phase 2");
    expect(container.textContent).toContain("Jordan Smith");
    expect(container.textContent).toContain("Alex Johnson");
  });

  it("marks the stale row with data-stale=true and fresh row with data-stale=false", () => {
    mocks.usePendingRfpMock.mockReturnValue({
      deals: FIXTURE_DEALS,
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    root = renderRoute(container);

    const staleRow = container.querySelector('[data-testid="pending-rfp-row-deal-stale-111"]');
    const freshRow = container.querySelector('[data-testid="pending-rfp-row-deal-fresh-222"]');

    expect(staleRow).not.toBeNull();
    expect(freshRow).not.toBeNull();
    expect(staleRow?.getAttribute("data-stale")).toBe("true");
    expect(freshRow?.getAttribute("data-stale")).toBe("false");
  });

  it("renders the empty state when deals list is empty", () => {
    mocks.usePendingRfpMock.mockReturnValue({
      deals: [],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    root = renderRoute(container);

    expect(container.textContent).toContain("No deals");
  });

  it("renders the error state when error is set and does NOT show the empty-queue message", () => {
    mocks.usePendingRfpMock.mockReturnValue({
      deals: null,
      loading: false,
      error: "Network error",
      refetch: vi.fn(),
    });

    root = renderRoute(container);

    expect(container.textContent).toContain("Network error");
    // Error state must not fall through to the empty-queue message — that would mislead
    // the user into thinking there are simply no pending RFPs when the fetch failed.
    expect(container.textContent).not.toContain("No deals");
  });

  it("suppresses rows when the latest fetch errored (no stale/cross-office rows under an error banner)", () => {
    // The hook still RETAINS `deals` across a transient error (so a successful retry restores them without
    // a flash), but the PAGE must not render those rows beneath an error banner — after a failed ?officeId
    // switch they could be the previous office's rows. Error banner stands alone (no rows, no empty message).
    mocks.usePendingRfpMock.mockReturnValue({
      deals: FIXTURE_DEALS,
      loading: false,
      error: "Refresh failed",
      refetch: vi.fn(),
    });

    root = renderRoute(container);

    // Error banner visible
    expect(container.textContent).toContain("Refresh failed");
    // Rows suppressed — not shown under the error (could be stale / wrong-office data)
    expect(container.textContent).not.toContain("Sunset Ridge Apartments");
    expect(container.textContent).not.toContain("Riverside Commons Phase 2");
    // But NOT the misleading "no pending RFPs" empty message either — the fetch failed, it isn't empty
    expect(container.textContent).not.toContain("No deals");
  });

  it("appends the current query string to deal links so a cross-office viewer keeps their office context", () => {
    mocks.usePendingRfpMock.mockReturnValue({
      deals: FIXTURE_DEALS,
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    root = renderRoute(container, "/deals/pending-rfp?officeId=office-atlanta");

    const links = Array.from(container.querySelectorAll("a"));
    const dealLink = links.find((a) => a.href.includes("deal-stale-111"));
    expect(dealLink).toBeTruthy();
    // Link must carry the original query string so the cross-office context is preserved.
    expect(dealLink?.getAttribute("href")).toContain("officeId=office-atlanta");
  });
});
