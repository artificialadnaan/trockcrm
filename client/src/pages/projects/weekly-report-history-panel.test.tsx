// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The History tab is where a PM lands when they go looking for a report that did not arrive, so the
// controls it offers decide what they do next. Offering "Send correction" as the only action on a failed
// send is how a client ended up receiving nothing at all: the clone becomes the week's live version, the
// failure comes off the board with it, and a PM pulled away mid-draft leaves the board reading "approved,
// waiting on the PM" — indistinguishable from a Send button nobody has pressed.

const mocks = vi.hoisted(() => ({
  reports: [] as any[],
  refetch: vi.fn(),
  fetchWeeklyReportDetail: vi.fn(),
  createWeeklyReportCorrection: vi.fn(),
  retryWeeklyReportSend: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/hooks/use-weekly-reports", () => ({
  useWeeklyReportHistory: () => ({
    reports: mocks.reports,
    loading: false,
    error: null,
    refetch: mocks.refetch,
  }),
  fetchWeeklyReportDetail: mocks.fetchWeeklyReportDetail,
  createWeeklyReportCorrection: mocks.createWeeklyReportCorrection,
  retryWeeklyReportSend: mocks.retryWeeklyReportSend,
}));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError, success: mocks.toastSuccess } }));

import { WeeklyReportHistoryPanel } from "./weekly-report-history-panel";

const PROJECT = {
  id: "p1",
  propertyDisplayName: "4123 Cedar Springs",
  dealName: "4123 Cedar Springs",
  clientName: "Mack Real Estate Group",
} as any;

function report(overrides: Record<string, unknown> = {}) {
  return {
    id: "r1",
    weekOf: "2026-08-13",
    version: 1,
    status: "sent",
    authoredByName: "Steve Sanchez",
    completionPercent: 42,
    photos: [],
    supersededById: null,
    sentAt: new Date().toISOString(),
    sendDeliveredAt: null,
    sendError: null,
    sendAttempts: 0,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.reports = [];
  mocks.refetch.mockReset();
  mocks.createWeeklyReportCorrection.mockReset();
  mocks.retryWeeklyReportSend.mockReset();
  mocks.toastError.mockReset();
  mocks.toastSuccess.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function render() {
  act(() => {
    root.render(
      <WeeklyReportHistoryPanel
        projects={[PROJECT]}
        refreshSignal={0}
        onSend={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
  });
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find(
    (element) => element.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;
}

describe("a sent report the client has not received", () => {
  it("offers Retry send, not only a correction", () => {
    mocks.reports = [report({ sendError: "Resend timed out" })];
    render();
    expect(button("Retry send")).toBeDefined();
  });

  it("retries that exact report, inside the provider's dedupe window", async () => {
    mocks.retryWeeklyReportSend.mockResolvedValue({});
    mocks.reports = [report({ id: "v1", sendError: "Resend timed out" })];
    render();
    await act(async () => {
      button("Retry send")!.click();
    });
    expect(mocks.retryWeeklyReportSend).toHaveBeenCalledWith("v1", false);
  });

  it("warns before a correction that the send never reached the client", async () => {
    // The old confirm text described what a correction does to a client who HAS the report, which is the
    // wrong client entirely when the email failed. A PM reading it had no way to know this is not how a
    // failed send is fixed.
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    mocks.reports = [report({ sendError: "Resend timed out" })];
    render();
    await act(async () => {
      button("Send correction")!.click();
    });
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/never reached the client/i));
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/Retry send instead/i));
    expect(mocks.createWeeklyReportCorrection).not.toHaveBeenCalled();
  });
});

describe("a sent report the provider accepted", () => {
  it("offers a correction and no retry", () => {
    mocks.reports = [report({ sendDeliveredAt: "2026-08-13T22:00:00.000Z" })];
    render();
    expect(button("Retry send")).toBeUndefined();
    expect(button("Send correction")).toBeDefined();
  });

  it("uses the wording that fits a client who already has a copy", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    mocks.reports = [report({ sendDeliveredAt: "2026-08-13T22:00:00.000Z" })];
    render();
    await act(async () => {
      button("Send correction")!.click();
    });
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/replaces the copy they already have/i));
  });
});

describe("only the newest version of a week may be corrected", () => {
  it("hides the button on an older version once a correction exists", () => {
    // A report is only marked superseded when its replacement is SENT, so a v1 with an unsent v2 sitting
    // beside it is still un-superseded — and used to be offered the button a second time, producing a v3
    // that leaves the week reporting a report the client already received. The server refuses that
    // outright; this stops the UI inviting it.
    mocks.reports = [
      report({ id: "v2", version: 2, status: "approved", sendDeliveredAt: null }),
      report({ id: "v1", version: 1, sendDeliveredAt: "2026-08-13T22:00:00.000Z" }),
    ];
    render();
    expect(button("Send correction")).toBeUndefined();
  });

  it("keeps it on the newest sent version", () => {
    mocks.reports = [
      report({ id: "v2", version: 2, sendDeliveredAt: "2026-08-14T22:00:00.000Z" }),
      report({
        id: "v1",
        version: 1,
        supersededById: "v2",
        sendDeliveredAt: "2026-08-13T22:00:00.000Z",
      }),
    ];
    render();
    expect(button("Send correction")).toBeDefined();
  });
});
