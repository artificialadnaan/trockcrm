// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { MyCleanupPage } from "./my-cleanup-page";

const mocks = vi.hoisted(() => ({
  useMyCleanupQueueMock: vi.fn(),
  dialogMock: vi.fn(),
  refetchMock: vi.fn(),
}));

vi.mock("@/hooks/use-ownership-cleanup", () => ({
  useMyCleanupQueue: mocks.useMyCleanupQueueMock,
}));

vi.mock("./my-cleanup-deal-editor-dialog", () => ({
  MyCleanupDealEditorDialog: (props: {
    dealId: string | null;
    open: boolean;
    onSaved: () => void;
    onOpenChange: (open: boolean) => void;
  }) => {
    mocks.dialogMock(props);
    return props.open ? (
      <div>
        <div>Deal editor open for {props.dealId}</div>
        <button
          onClick={() => {
            props.onSaved();
            props.onOpenChange(false);
          }}
        >
          Save Cleanup Deal
        </button>
        <button onClick={() => props.onOpenChange(false)}>Close Cleanup Deal</button>
      </div>
    ) : null;
  },
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => <button {...props}>{children}</button>,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

function renderRoute(container: HTMLElement) {
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={["/pipeline/my-cleanup"]}>
        <Routes>
          <Route path="/pipeline/my-cleanup" element={<MyCleanupPage />} />
        </Routes>
      </MemoryRouter>
    );
  });
  return root;
}

describe("MyCleanupPage route", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.innerHTML = "";
    document.body.appendChild(container);
    root = null;
    mocks.dialogMock.mockReset();
    mocks.refetchMock.mockReset();
    mocks.useMyCleanupQueueMock.mockReturnValue({
      rows: [],
      total: 0,
      loading: true,
      error: null,
      refetch: mocks.refetchMock,
    });
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container.remove();
  });

  it("renders the route shell at /pipeline/my-cleanup", () => {
    root = renderRoute(container);

    expect(container.textContent).toContain("My Cleanup");
    expect(container.textContent).toContain("Loading cleanup queue...");
  });

  it("opens deal cards inline and refetches after save while keeping leads routed out", () => {
    mocks.useMyCleanupQueueMock.mockReturnValue({
      rows: [
        {
          recordType: "deal",
          recordId: "deal-1",
          recordName: "Watermere Roof Replacement",
          companyName: "Watermere",
          stageName: "Estimating",
          reasonCode: "missing_next_step",
          severity: "high",
          officeId: "office-1",
          officeName: "Dallas",
          assignedUserId: "user-1",
          assignedUserName: "Sales Rep",
          generatedAt: "2026-04-21T12:00:00.000Z",
          evaluatedAt: "2026-04-21T12:00:00.000Z",
        },
        {
          recordType: "lead",
          recordId: "lead-1",
          recordName: "Qualified Lead",
          companyName: "Acme",
          stageName: "Lead Go/No-Go",
          reasonCode: "missing_budget_status",
          severity: "medium",
          officeId: "office-1",
          officeName: "Dallas",
          assignedUserId: "user-1",
          assignedUserName: "Sales Rep",
          generatedAt: "2026-04-21T12:00:00.000Z",
          evaluatedAt: "2026-04-21T12:00:00.000Z",
        },
      ],
      total: 2,
      loading: false,
      error: null,
      refetch: mocks.refetchMock,
    });

    root = renderRoute(container);

    const dealCard = Array.from(container.querySelectorAll("article")).find((article) =>
      article.textContent?.includes("Watermere Roof Replacement")
    );
    expect(dealCard).not.toBeNull();

    act(() => {
      dealCard?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Deal editor open for deal-1");

    const leadLink = container.querySelector('a[href="/leads/lead-1"]');
    expect(leadLink).not.toBeNull();

    const saveButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Save Cleanup Deal")
    );
    expect(saveButton).not.toBeNull();

    act(() => {
      saveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mocks.refetchMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("Deal editor open for deal-1");
  });

  it("keeps an explicit edit button for deal rows", () => {
    mocks.useMyCleanupQueueMock.mockReturnValue({
      rows: [
        {
          recordType: "deal",
          recordId: "deal-2",
          recordName: "Boynton Beach Clubhouse",
          companyName: "Boynton Beach",
          stageName: "Proposal Sent",
          reasonCode: "missing_expected_close_date",
          severity: "medium",
          officeId: "office-1",
          officeName: "Dallas",
          assignedUserId: "user-1",
          assignedUserName: "Sales Rep",
          generatedAt: "2026-04-21T12:00:00.000Z",
          evaluatedAt: "2026-04-21T12:00:00.000Z",
        },
      ],
      total: 1,
      loading: false,
      error: null,
      refetch: mocks.refetchMock,
    });

    root = renderRoute(container);

    const editButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Edit Deal")
    );
    expect(editButton).not.toBeNull();

    act(() => {
      editButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Deal editor open for deal-2");
  });
});
