// @vitest-environment jsdom
//
// The Daily Activity Log carries the CONTENT of what people logged, including synced email bodies, so it is
// limited to the DAILY_ACTIVITY_LOG_VIEWER_EMAILS allowlist. These cases pin the client half: a denied user
// sees an explanation, and — the part that actually matters — the report never mounts, so no request is
// fired at an endpoint that would 403.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

let authUser: { id: string; email: string; canViewDailyActivityLog?: boolean } | null = null;

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: authUser }),
}));

// Counts every attempt to load the report. A denied render must leave this at zero: the gate exists partly
// so we never ask for data the server will refuse.
const fetchReport = vi.fn();

vi.mock("@/components/reports/report-filter-bar", () => ({
  ReportFilterBar: () => <div>Report Filters</div>,
  useReportFilters: () => ({
    filters: { dateFrom: "2026-06-01", dateTo: "2026-06-30", office: "all", ownerNames: [] },
    query: { dateFrom: "2026-06-01", dateTo: "2026-06-30", office: "all", ownerNames: [] },
    setFilters: () => {},
  }),
}));

vi.mock("@/hooks/use-reports", () => ({
  useDailyActivityLogReport: (options: unknown) => {
    fetchReport(options);
    return { data: null, loading: false, error: null };
  },
}));

const { DailyActivityLogPage } = await import("./daily-activity-log-page");

function render() {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/reports/performance/daily-activity-log"]}>
      <DailyActivityLogPage />
    </MemoryRouter>
  );
}

beforeEach(() => {
  fetchReport.mockClear();
});
afterEach(() => {
  authUser = null;
});

describe("DailyActivityLogPage access gate", () => {
  it("explains the restriction and loads nothing for a user the server did not flag", () => {
    authUser = { id: "u1", email: "someadmin@trockgc.com", canViewDailyActivityLog: false };
    const html = render();

    expect(html).toContain("limited to designated viewers");
    expect(fetchReport).not.toHaveBeenCalled();
  });

  it("treats an absent flag as denied — an older session predates the flag", () => {
    authUser = { id: "u2", email: "someone@trockgc.com" };
    const html = render();

    expect(html).toContain("limited to designated viewers");
    expect(fetchReport).not.toHaveBeenCalled();
  });

  it("denies a signed-out render rather than throwing", () => {
    authUser = null;
    const html = render();

    expect(html).toContain("limited to designated viewers");
    expect(fetchReport).not.toHaveBeenCalled();
  });

  it("renders the report and requests data for a flagged viewer", () => {
    authUser = { id: "u3", email: "tyamashita@trockgc.com", canViewDailyActivityLog: true };
    const html = render();

    expect(html).not.toContain("limited to designated viewers");
    expect(html).toContain("Report Filters");
    expect(fetchReport).toHaveBeenCalledTimes(1);
  });
});
