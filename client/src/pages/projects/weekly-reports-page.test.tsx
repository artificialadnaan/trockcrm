// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useWeeklyReportDashboard: vi.fn(),
  useWeeklyReportProjects: vi.fn(),
  dismissWeeklyReportWeek: vi.fn(),
  historyRefetch: vi.fn(),
  retryWeeklyReportSend: vi.fn(),
  sendDialogReportId: null as string | null,
  auditDialogProjectId: null as string | null,
}));

vi.mock("@/hooks/use-weekly-reports", () => ({
  useWeeklyReportDashboard: mocks.useWeeklyReportDashboard,
  useWeeklyReportProjects: mocks.useWeeklyReportProjects,
  dismissWeeklyReportWeek: mocks.dismissWeeklyReportWeek,
  useWeeklyReportHistory: () => ({
    reports: [],
    loading: false,
    error: null,
    refetch: mocks.historyRefetch,
  }),
  useWeeklyReportSettings: () => ({ settings: null, loading: false, error: null, refetch: vi.fn() }),
  useWeeklyReportAssignableUsers: () => ({ users: [], loading: false, error: null }),
  fetchWeeklyReportDetail: vi.fn(),
  saveWeeklyReportSettings: vi.fn(),
  createWeeklyReportProject: vi.fn(),
  updateWeeklyReportProject: vi.fn(),
  deleteWeeklyReportProject: vi.fn(),
  // The send flow's exports. vi.mock replaces the WHOLE module, so anything the page or the panels
  // import has to appear here or the import resolves to undefined at render time.
  retryWeeklyReportSend: mocks.retryWeeklyReportSend,
  fetchWeeklyReportSendDraft: vi.fn(),
  sendWeeklyReport: vi.fn(),
  createWeeklyReportCorrection: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
// Stand-in for the send dialog, so a Send click can be asserted by WHICH report it opens for. The real
// dialog fetches a draft on mount, and the id it is handed is the whole point: on a row carrying both a
// correction and a failed send, a Send pointed at the failed report renders identically to one pointed at
// the correction.
// Stand-in for the record drill-in, so a row click can be asserted by WHICH project it opens. The real
// dialog fetches the audit on mount; the id it is handed is the whole assertion here.
vi.mock("./weekly-report-project-audit-dialog", () => ({
  WeeklyReportProjectAuditDialog: ({ projectId }: { projectId: string }) => {
    mocks.auditDialogProjectId = projectId;
    return null;
  },
}));
vi.mock("./weekly-report-send-dialog", () => ({
  WeeklyReportSendDialog: ({ reportId }: { reportId: string }) => {
    mocks.sendDialogReportId = reportId;
    return null;
  },
}));

import WeeklyReportsPage, { fmtWeek, latenessLabel } from "./weekly-reports-page";

let container: HTMLDivElement;
let root: Root;

function dashboardRow(overrides: Record<string, unknown> = {}) {
  return {
    weeklyReportProjectId: "p1",
    dealId: "d1",
    projectName: "4123 Cedar Springs",
    projectNumber: "DFW-10432",
    clientName: "Mack Real Estate Group",
    trockPmUserId: "u-pm",
    trockPmName: "Adam Sherwood",
    trockSuperUserId: "u-super",
    trockSuperName: "Steve Sanchez",
    weekOf: "2026-08-13",
    isCurrentWeek: true,
    state: "not_started",
    daysLate: 0,
    reportId: null,
    reportVersion: null,
    sentAt: null,
    sendError: null,
    // Added with migration 0226. All three verdicts are derived on the SERVER — the CRM and the app must
    // not each decide what "Send failed" means — so the fixture carries them rather than the page
    // inferring anything. `sendRetryReportId` is which report a Retry addresses, which is NOT always the
    // week's live report once a correction has been drafted over a failed send — and `sendRetrySentAt`
    // is THAT report's `sent_at`, which is what the provider's 24-hour dedupe window is measured against.
    sendDeliveredAt: null,
    // Added with 0227. `sendBounced` is a FOURTH verdict rather than a variant of the three above, and
    // the only one whose `sendDeliveredAt` is set: the provider accepted the message and the receiving
    // server then refused it, so every predicate keyed on a missing delivery reads it as a success.
    sendDeliveryStatus: null,
    sendAttempts: 0,
    sendFailed: false,
    sendStalled: false,
    sendPending: false,
    sendBounced: false,
    sendRetryReportId: null,
    sendRetrySentAt: null,
    waitingOn: "Steve Sanchez",
    dismissalReason: null,
    ...overrides,
  };
}

/** The "Send failures" stat card's number — the figure a director reads before anything else. */
function sendFailureCount(): string | undefined {
  const card = Array.from(container.querySelectorAll("div")).find((element) =>
    Array.from(element.children).some((child) => child.textContent?.trim() === "Send failures"),
  );
  return card?.children[1]?.textContent?.trim();
}

function renderPage() {
  act(() => {
    root.render(
      <MemoryRouter initialEntries={["/projects/weekly-reports"]}>
        <WeeklyReportsPage />
      </MemoryRouter>,
    );
  });
  return container.textContent ?? "";
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.useWeeklyReportDashboard.mockReset();
  mocks.useWeeklyReportProjects.mockReset();
  // Plain state, not a vi.fn, so mockReset does not clear it — a stale id would let a test that opens no
  // dialog at all inherit the previous one's and pass.
  mocks.sendDialogReportId = null;
  mocks.auditDialogProjectId = null;
  mocks.useWeeklyReportProjects.mockReturnValue({
    projects: [],
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
  mocks.historyRefetch.mockReset();
  mocks.retryWeeklyReportSend.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mockDashboard(rows: ReturnType<typeof dashboardRow>[], extra: Record<string, unknown> = {}) {
  mocks.useWeeklyReportDashboard.mockReturnValue({
    data: { asOf: "2026-08-13", rows, olderOutstandingCounts: {}, lookbackWeeks: 26, ...extra },
    rows,
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
}

describe("date formatting", () => {
  it("renders week_of as the stored calendar date regardless of timezone", () => {
    // week_of is a plain date. Parsing it as local time renders the previous day for anyone west of
    // Greenwich, which would put every report under the wrong week on the page.
    expect(fmtWeek("2026-08-13")).toBe("Aug 13, 2026");
    expect(fmtWeek("2026-01-01")).toBe("Jan 1, 2026");
  });
});

describe("lateness copy", () => {
  it("reads as due, not late, on the due date", () => {
    expect(latenessLabel(dashboardRow({ daysLate: 0 }) as never)).toBe("Due");
  });

  it("singularises one day", () => {
    expect(latenessLabel(dashboardRow({ daysLate: 1 }) as never)).toBe("1 day late");
    expect(latenessLabel(dashboardRow({ daysLate: 3 }) as never)).toBe("3 days late");
  });

  it("never calls a settled week late", () => {
    expect(latenessLabel(dashboardRow({ state: "sent", daysLate: 9 }) as never)).toBe("Sent");
    expect(latenessLabel(dashboardRow({ state: "dismissed", daysLate: 9 }) as never)).toBe("Dismissed");
  });
});

describe("This Week board", () => {
  it("shows a week nobody has started — the row a reports-table query would omit", () => {
    mockDashboard([dashboardRow()]);
    const text = renderPage();
    expect(text).toContain("4123 Cedar Springs");
    expect(text).toContain("Not started");
    expect(text).toContain("Steve Sanchez");
  });

  it("names the PM once the super has submitted", () => {
    mockDashboard([dashboardRow({ state: "pending_review", waitingOn: "Adam Sherwood" })]);
    const text = renderPage();
    expect(text).toContain("Pending PM review");
    expect(text).toContain("Adam Sherwood");
  });

  it("counts outstanding weeks, excluding settled ones", () => {
    mockDashboard([
      dashboardRow({ state: "not_started", daysLate: 7, isCurrentWeek: false, weekOf: "2026-08-06" }),
      dashboardRow({ state: "pending_review" }),
      dashboardRow({ state: "sent", weeklyReportProjectId: "p2", projectName: "Other" }),
    ]);
    const text = renderPage();
    // Outstanding = 2 (not_started + pending_review); Overdue = 1; With the PM = 1.
    expect(text).toContain("Outstanding");
    expect(text).toContain("7 days late");
  });

  it("surfaces a send failure rather than showing the week as done", () => {
    // Keyed on `sendFailed`, which the server derives, rather than on `sendError` alone: the error text
    // is deliberately LEFT in place after a retry succeeds, as the record of what happened, so a chip
    // reading the raw error would keep shouting about a delivery that has since reached the client.
    // `reportId` is present because a `sent` week always has a report behind it — and the retry has to
    // address one. A fixture without it would render the chip and silently no retry button.
    mockDashboard([
      dashboardRow({
        state: "sent",
        reportId: "r1",
        sendRetryReportId: "r1",
        sendError: "SMTP timeout",
        sendAttempts: 2,
        sendFailed: true,
      }),
    ]);
    const text = renderPage();
    expect(text).toContain("Send failed");
    expect(text).toContain("Retry send");
  });

  it("surfaces a send that failed with NO error recorded at all", () => {
    // The delivery job writes its own outcome to the same database whose absence is the likeliest reason
    // it failed, so "committed, never delivered, nothing written down" is an ordinary end state. Keyed on
    // the error text it looked exactly like a send queued five seconds ago, and the row then disappeared
    // from the board entirely the following week.
    mockDashboard([
      dashboardRow({
        state: "sent",
        reportId: "r1",
        sendRetryReportId: "r1",
        sendError: null,
        sendAttempts: 0,
        sendStalled: true,
      }),
    ]);
    const text = renderPage();
    expect(text).toContain("Send stuck");
    expect(text).toContain("Retry send");
  });

  it("does not tell the PM nothing was recorded when three attempts were", async () => {
    // "Send stuck" replaces "Send failed" once a retry clears the error, and its title used to read
    // flatly "This report was marked sent but no delivery was ever recorded" — which contradicted the
    // "· 3 attempts" the PM was reading a moment earlier, on a row whose error text this platform had
    // itself just erased. The chip now carries the count and the title says what actually happened.
    mockDashboard([
      dashboardRow({
        state: "sent",
        reportId: "r1",
        sendRetryReportId: "r1",
        sendError: null,
        sendAttempts: 3,
        sendStalled: true,
      }),
    ]);
    const text = renderPage();
    expect(text).toContain("Send stuck");
    expect(text).toContain("3 attempts");

    const chip = Array.from(container.querySelectorAll("div[title]")).find((element) =>
      (element.textContent ?? "").includes("Send stuck"),
    );
    if (!chip) throw new Error("Send stuck chip not found");
    const title = chip.getAttribute("title") ?? "";
    expect(title).toMatch(/attempted 3 times/i);
    expect(title).not.toMatch(/no delivery was ever/i);
  });

  it("points Retry at the undelivered report, not at the correction drafted over it", async () => {
    // The live row is the unsent v2; the report that needs retrying is v1. Retrying the live row would
    // replay a report nobody ever sent — so this asserts the ID THE CALL CARRIES, not merely that a
    // button rendered. A button pointed at the wrong report renders exactly the same.
    mocks.retryWeeklyReportSend.mockResolvedValue({});
    mockDashboard([
      dashboardRow({
        state: "approved",
        reportId: "v2",
        sendRetryReportId: "v1",
        // The LIVE row is the unsent clone, so it has no `sent_at` at all — the real shape of this state,
        // and the reason the age of the send has to come off `sendRetrySentAt` instead.
        sentAt: null,
        sendRetrySentAt: new Date().toISOString(),
        sendError: "SMTP timeout",
        sendFailed: true,
      }),
    ]);
    const text = renderPage();
    expect(text).toContain("Send failed");

    const retry = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Retry send",
    );
    if (!retry) throw new Error("Retry send button not found");
    await act(async () => {
      retry.click();
    });
    // Inside the provider's idempotency window, so no duplicate-risk acknowledgement is claimed — and no
    // confirmation was raised. Measured off `row.sentAt` the clone's null reads as "outside the window",
    // and the PM is warned about a second copy the provider provably will not send: a false alarm on the
    // one dialog on this page that is ever real.
    expect(mocks.retryWeeklyReportSend).toHaveBeenCalledWith("v1", false);
  });

  it("ALSO offers Send for the correction, which Retry used to hide", async () => {
    // Same state as the test above, asserted from the other side. The actions cell was an if/else chain
    // with Retry first, so this row — `approved` AND carrying a "Send failed" chip — rendered Retry alone.
    // The PM had just written a correction and the only button on the row replayed the OLD content; the
    // correction had no path off This Week at all, only through the History tab.
    //
    // Both belong here and they do different jobs: Retry replays the send that failed, for a transport
    // problem; Send delivers the correction, for a content one.
    mockDashboard([
      dashboardRow({
        state: "approved",
        reportId: "v2",
        sendRetryReportId: "v1",
        sentAt: null,
        sendRetrySentAt: new Date().toISOString(),
        sendError: "SMTP timeout",
        sendFailed: true,
      }),
    ]);
    renderPage();

    const labels = Array.from(container.querySelectorAll("button")).map((button) =>
      button.textContent?.trim(),
    );
    expect(labels).toContain("Retry send");
    expect(labels).toContain("Send");

    const send = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Send",
    );
    if (!send) throw new Error("Send button not found");
    await act(async () => {
      send.click();
    });
    // The CORRECTION, not the report that failed. A Send pointed at v1 renders identically.
    expect(mocks.sendDialogReportId).toBe("v2");
  });

  it("still offers Send alone when nothing has failed", async () => {
    // The control for the case above. Without it, a cell that rendered Retry unconditionally — or one
    // that dropped the failure branch entirely — would satisfy it.
    mockDashboard([dashboardRow({ state: "approved", reportId: "v2" })]);
    renderPage();

    const labels = Array.from(container.querySelectorAll("button")).map((button) =>
      button.textContent?.trim(),
    );
    expect(labels).toContain("Send");
    expect(labels).not.toContain("Retry send");
  });

  it("makes the PM acknowledge the duplicate risk on a send too old to be deduped", async () => {
    // Resend forgets an idempotency key after 24 hours while this chip lives on the board for 26 weeks,
    // so a replay past the window is a genuinely second email. The server refuses without the
    // acknowledgement; this is the UI that earns it.
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    mocks.retryWeeklyReportSend.mockResolvedValue({});
    mockDashboard([
      dashboardRow({
        state: "sent",
        reportId: "r1",
        sendRetryReportId: "r1",
        sentAt: "2026-08-01T10:00:00.000Z",
        sendRetrySentAt: "2026-08-01T10:00:00.000Z",
        sendError: "SMTP timeout",
        sendFailed: true,
      }),
    ]);
    renderPage();
    const retry = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Retry send",
    );
    await act(async () => {
      retry!.click();
    });
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/second copy/i));
    expect(mocks.retryWeeklyReportSend).toHaveBeenCalledWith("r1", true);
    confirm.mockRestore();
  });

  it("sends nothing when the PM declines that confirmation", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    mockDashboard([
      dashboardRow({
        state: "sent",
        reportId: "r1",
        sendRetryReportId: "r1",
        sentAt: "2026-08-01T10:00:00.000Z",
        sendRetrySentAt: "2026-08-01T10:00:00.000Z",
        sendError: "SMTP timeout",
        sendFailed: true,
      }),
    ]);
    renderPage();
    const retry = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Retry send",
    );
    await act(async () => {
      retry!.click();
    });
    expect(mocks.retryWeeklyReportSend).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("does not call a send that is merely still queued a failure", () => {
    // No error yet — the job was enqueued seconds ago. Calling that "Send failed" would have PMs
    // re-sending on top of deliveries that are simply in flight.
    mockDashboard([
      dashboardRow({ state: "sent", sendFailed: false, sendPending: true, sendDeliveredAt: null }),
    ]);
    const text = renderPage();
    expect(text).not.toContain("Send failed");
    expect(text).not.toContain("Send stuck");
    expect(text).toContain("Sending…");
  });

  it("stops calling it a failure once the retry has delivered it", () => {
    mockDashboard([
      dashboardRow({
        state: "sent",
        sendError: "SMTP timeout",
        sendFailed: false,
        sendStalled: false,
        sendPending: false,
        sendDeliveredAt: "2026-08-13T22:00:00.000Z",
      }),
    ]);
    const text = renderPage();
    expect(text).not.toContain("Send failed");
    expect(text).not.toContain("Send stuck");
    expect(text).not.toContain("Sending…");
  });

  it("surfaces a week the provider reported as NOT DELIVERED, and counts it as a failure", () => {
    // The state that used to be indistinguishable from success on this page. A bounced report carries
    // `sendDeliveredAt`, so `sendFailed`, `sendStalled` and `sendPending` are all false — the fixture says
    // so explicitly — and the row rendered as a plain sent week while the client had nothing.
    mockDashboard([
      dashboardRow({
        state: "sent",
        sendFailed: false,
        sendStalled: false,
        sendPending: false,
        sendBounced: true,
        sendDeliveryStatus: "bounced",
        sendDeliveredAt: "2026-08-13T22:00:00.000Z",
        waitingOn: "Adam Sherwood",
      }),
    ]);
    const text = renderPage();
    expect(text).toContain("Not delivered");
    expect(text).not.toContain("Send stuck");
    expect(text).not.toContain("Sending…");
    // And it reaches the NUMBER a director reads, not only the row. Without it the card would read 0 on a
    // board carrying a client who never got their report.
    expect(sendFailureCount()).toBe("1");
  });

  it("does NOT say `Not delivered` for a week nothing has been reported on — the control", () => {
    // A page that showed the chip unconditionally would pass the test above. A `sent` week with no
    // verdict is unknown, not failed.
    mockDashboard([
      dashboardRow({ state: "sent", sendDeliveredAt: "2026-08-13T22:00:00.000Z", sendBounced: false }),
    ]);
    expect(renderPage()).not.toContain("Not delivered");
    expect(sendFailureCount()).toBe("0");
  });

  it("offers Send on an approved week, so the PM never has to leave the board", () => {
    mockDashboard([dashboardRow({ state: "approved", reportId: "r1", waitingOn: "Adam Sherwood" })]);
    expect(renderPage()).toContain("Send");
  });

  it("declares outstanding weeks hidden by the lookback window", () => {
    // Silent truncation would read as "all caught up" on a project months behind.
    mockDashboard([dashboardRow()], { olderOutstandingCounts: { p1: 9 } });
    const text = renderPage();
    expect(text).toContain("9 more outstanding week");
    expect(text).toContain("26 weeks");
  });

  it("says nothing is due when the cadence produced no weeks", () => {
    mockDashboard([]);
    const text = renderPage();
    expect(text).toContain("Nothing is due");
  });

  it("does NOT say nothing is due when every outstanding week is older than the window", () => {
    // The banner that declares hidden weeks sits under the table, so an empty board returned before it and
    // reported "Nothing is due" over weeks that are genuinely owed — the exact all-caught-up misreading the
    // banner exists to prevent. Reachable: an undelivered send on a stopped setup lands only in this tally.
    mockDashboard([], { olderOutstandingCounts: { p1: 3 } });
    const text = renderPage();
    expect(text).not.toContain("Nothing is due");
    expect(text).toContain("3 outstanding weeks are older");
  });

  it("marks a backlog week so it is not mistaken for this week's", () => {
    mockDashboard([dashboardRow({ isCurrentWeek: false, weekOf: "2026-08-06", daysLate: 7 })]);
    expect(renderPage()).toContain("backlog");
  });
});

describe("Refresh", () => {
  function clickButton(label: string) {
    const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
      (candidate.textContent ?? "").includes(label),
    );
    if (!button) throw new Error(`No button labelled ${label}`);
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("reloads the History table as well as the board", () => {
    // History owns a SEPARATE request, keyed on the project picked inside the tab. A Refresh that only
    // reloads the dashboard and the setup list leaves that table showing the state from before the
    // report which prompted the refresh was ever sent.
    mockDashboard([dashboardRow()]);
    mocks.useWeeklyReportProjects.mockReturnValue({
      projects: [{ id: "p1", dealId: "d1", propertyDisplayName: "4123 Cedar Springs", clientName: null }],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    renderPage();
    clickButton("History");
    // The hook is mocked, so nothing has fetched yet — anything counted here would be the mount, not
    // the gesture under test.
    expect(mocks.historyRefetch).not.toHaveBeenCalled();

    clickButton("Refresh");
    expect(mocks.historyRefetch).toHaveBeenCalledTimes(1);
  });
});

describe("failure states", () => {
  it("shows the server's error instead of an empty board", () => {
    mocks.useWeeklyReportDashboard.mockReturnValue({
      data: null,
      rows: [],
      loading: false,
      error: "Couldn't load the weekly report board",
      refetch: vi.fn(),
    });
    expect(renderPage()).toContain("Couldn't load the weekly report board");
  });
});

/**
 * THE WAY IN, from the tab people land on.
 *
 * The record drill-in shipped on the Projects tab only. This is the default view, so from where anyone
 * stands when they open Weekly Reports it did not exist — which is exactly how it was reported: "the
 * cards for the projects aren't clickable".
 */
describe("opening a project's record from This Week", () => {
  function firstRow(): HTMLTableRowElement {
    const row = container.querySelector("tbody tr");
    expect(row).toBeTruthy();
    return row as HTMLTableRowElement;
  }

  it("opens the record for the project on the row that was clicked", () => {
    mockDashboard([
      dashboardRow({ weeklyReportProjectId: "p-first" }),
      dashboardRow({ weeklyReportProjectId: "p-second", weekOf: "2026-08-06" }),
    ]);
    renderPage();

    act(() => {
      firstRow().click();
    });

    expect(mocks.auditDialogProjectId).toBe("p-first");
  });

  it("offers the record through a real button, not a row click a keyboard cannot reach", () => {
    // A bare `<tr onClick>` is a mouse affordance and nothing else: no focus, no Enter, no announcement.
    // Wiring the row without this left keyboard users with NO way into the record at all, which is worse
    // than the Projects-tab-only drill-in it was fixing. Asserting the element is a BUTTON is the point —
    // a div with the same handler passes any test that only clicks it.
    mockDashboard([dashboardRow({ weeklyReportProjectId: "p-keyboard", projectName: "4123 Cedar Springs" })]);
    renderPage();

    const named = Array.from(container.querySelectorAll("tbody button")).find(
      (element) => element.textContent?.trim() === "4123 Cedar Springs",
    );
    expect(named).toBeTruthy();

    act(() => {
      (named as HTMLButtonElement).click();
    });

    expect(mocks.auditDialogProjectId).toBe("p-keyboard");
  });

  it("does not open it when the row's own Send button was the target", () => {
    // Send opens the send dialog. Without stopPropagation the click also bubbles to the row, so a PM
    // pressing Send would get the record dialog stacked over the thing they actually asked for.
    mockDashboard([dashboardRow({ state: "approved", reportId: "r-approved" })]);
    renderPage();

    const send = Array.from(container.querySelectorAll("button")).find(
      (element) => element.textContent?.trim() === "Send",
    );
    expect(send).toBeTruthy();
    act(() => {
      send!.click();
    });

    expect(mocks.sendDialogReportId).toBe("r-approved");
    expect(mocks.auditDialogProjectId).toBeNull();
  });
});
