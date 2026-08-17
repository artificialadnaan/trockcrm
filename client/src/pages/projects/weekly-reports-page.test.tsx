// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useWeeklyReportDashboard: vi.fn(),
  useWeeklyReportProjects: vi.fn(),
  dismissWeeklyReportWeek: vi.fn(),
}));

vi.mock("@/hooks/use-weekly-reports", () => ({
  useWeeklyReportDashboard: mocks.useWeeklyReportDashboard,
  useWeeklyReportProjects: mocks.useWeeklyReportProjects,
  dismissWeeklyReportWeek: mocks.dismissWeeklyReportWeek,
  useWeeklyReportHistory: () => ({ reports: [], loading: false, error: null, refetch: vi.fn() }),
  useWeeklyReportSettings: () => ({ settings: null, loading: false, error: null, refetch: vi.fn() }),
  useWeeklyReportAssignableUsers: () => ({ users: [], loading: false, error: null }),
  fetchWeeklyReportDetail: vi.fn(),
  saveWeeklyReportSettings: vi.fn(),
  createWeeklyReportProject: vi.fn(),
  updateWeeklyReportProject: vi.fn(),
  deleteWeeklyReportProject: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

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
    waitingOn: "Steve Sanchez",
    dismissalReason: null,
    ...overrides,
  };
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
  mocks.useWeeklyReportProjects.mockReturnValue({
    projects: [],
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
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
    mockDashboard([dashboardRow({ state: "sent", sendError: "SMTP timeout" })]);
    const text = renderPage();
    expect(text).toContain("Send failed");
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

  it("marks a backlog week so it is not mistaken for this week's", () => {
    mockDashboard([dashboardRow({ isCurrentWeek: false, weekOf: "2026-08-06", daysLate: 7 })]);
    expect(renderPage()).toContain("backlog");
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
