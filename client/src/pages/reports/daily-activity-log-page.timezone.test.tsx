// Pins that a row's clock cannot contradict the day header it sits under.
//
// The server buckets days with `a.occurred_at::date`, which resolves in the Postgres session timezone
// (UTC in practice). If the page rendered clocks in the BROWSER's zone instead, an activity at
// 2026-06-02T00:30:00Z would appear under the "Jun 2" heading displaying "7:30 PM" to a Central
// reader — Monday-evening work presented as Tuesday evening. This report exists to tell a manager what
// someone did on a given day, so that contradiction is a correctness bug, not a cosmetic one.
//
// The whole file runs under America/Chicago on purpose: with TZ=UTC (how the suites normally run)
// local and UTC coincide and the bug is invisible, so this fixture would prove nothing.
//
// The zone is process-GLOBAL and Vitest reuses a worker across spec files, so setting it without
// putting it back would leak into whatever date-sensitive spec happens to run next in this worker --
// a failure that depends on file ordering rather than on any code change. The previous value is
// captured (not assumed to be "UTC") and restored in afterAll below; if TZ was unset originally it is
// deleted rather than pinned to a string, so the process goes back to the host zone exactly.
const PREVIOUS_TZ = process.env.TZ;
process.env.TZ = "America/Chicago";

import { afterAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

// The boundary fixture: 00:30 UTC on Jun 2 is 7:30 PM Jun 1 in Central.
const BOUNDARY_UTC = "2026-06-02T00:30:00.000Z";

vi.mock("@/hooks/use-accessible-offices", () => ({
  useAccessibleOffices: () => ({ offices: [], loading: false, error: null, refetch: vi.fn() }),
}));

vi.mock("@/components/reports/report-filter-bar", () => ({
  ReportFilterBar: () => <div>Report Filters</div>,
  useReportFilters: () => ({
    filters: { dateFrom: "2026-06-01", dateTo: "2026-06-30", office: "all", ownerNames: [] },
    query: { dateFrom: "2026-06-01", dateTo: "2026-06-30", office: "all", ownerIds: [], ownerNames: [] },
  }),
}));

vi.mock("@/hooks/use-reports", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/use-reports")>("@/hooks/use-reports");
  return {
    ...actual,
    useDailyActivityLogReport: () => ({
      loading: false,
      error: null,
      data: {
        kpis: { totalEntries: 1, notes: 1, daysCovered: 1, repsLogging: 1, offDayLogged: 0 },
        days: [
          {
            // The server filed this under Jun 2 because 00:30 UTC IS Jun 2 in UTC.
            date: "2026-06-02",
            entryCount: 1,
            noteCount: 1,
            repCount: 1,
            offDayLoggedCount: 0,
            entries: [
              {
                id: "act-boundary",
                type: "note",
                typeLabel: "Note",
                occurredAt: BOUNDARY_UTC,
                occurredDate: "2026-06-02",
                loggedAt: BOUNDARY_UTC,
                loggedDate: "2026-06-02",
                loggedSameDay: true,
                loggedDaysDiff: 0,
                responsibleUserId: "user-alice",
                responsibleName: "Alice Rep",
                performedByName: null,
                subject: "Late night writeup",
                body: "Filed just after midnight UTC.",
                outcome: null,
                nextStep: null,
                nextStepDueAt: null,
                contentRestricted: false,
                durationMinutes: null,
                targetType: "deal",
                targetName: "Roof Replacement - Tower A",
                dealId: "deal-1",
                dealName: "Roof Replacement - Tower A",
                dealNumber: "D-1001",
              },
            ],
          },
        ],
        pagination: { page: 1, limit: 200, total: 1, returned: 1, totalPages: 1, hasMore: false },
        appliedTypes: [],
      },
    }),
  };
});

const { DailyActivityLogPage } = await import("./daily-activity-log-page");

function render() {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/reports/performance/daily-activity-log"]}>
      <DailyActivityLogPage />
    </MemoryRouter>
  ).replace(/\s+/g, " ");
}

afterAll(() => {
  if (PREVIOUS_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = PREVIOUS_TZ;
});

describe("DailyActivityLogPage timezone consistency", () => {
  it("restores the process timezone for whatever spec runs next in this worker", () => {
    // Guards the cleanup itself. Inside this file the zone must still be Chicago (the assertions
    // below depend on it); the afterAll above is what hands it back. Asserting the captured value is
    // a real value here means a future edit cannot quietly drop the capture and leave the restore
    // writing "undefined" into the environment.
    expect(process.env.TZ).toBe("America/Chicago");
    expect(PREVIOUS_TZ === undefined || typeof PREVIOUS_TZ === "string").toBe(true);
  });

  it("confirms the fixture actually straddles a day boundary in this zone", () => {
    // Guards the test itself: if the runner's zone ever made these equal, the assertions below would
    // pass vacuously and stop protecting anything.
    const local = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(BOUNDARY_UTC));
    const utc = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(new Date(BOUNDARY_UTC));
    expect(local).toBe("7:30 PM");
    expect(utc).toBe("12:30 AM");
    expect(local).not.toBe(utc);
  });

  it("renders the row clock in UTC so it agrees with its UTC day header", () => {
    const html = render();

    expect(html).toContain("Tuesday, Jun 2, 2026");
    // 12:30 AM is Jun 2 in UTC — consistent with the heading above it.
    expect(html).toContain("12:30 AM");
    // 7:30 PM would be the browser-local rendering, which reads as Jun 2 EVENING under a Jun 2
    // heading while the work actually happened Jun 1 locally.
    expect(html).not.toContain("7:30 PM");
  });

  it("marks the times as UTC so a clock cannot be misread as local", () => {
    expect(render()).toContain("times UTC");
  });
});
