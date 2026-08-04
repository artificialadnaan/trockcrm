import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/components/reports/report-filter-bar", () => ({
  ReportFilterBar: () => <div>Report Filters</div>,
  useReportFilters: () => ({
    filters: { dateFrom: "2026-06-01", dateTo: "2026-06-30", office: "all", ownerNames: [] },
    query: { dateFrom: "2026-06-01", dateTo: "2026-06-30", office: "all", ownerIds: [], ownerNames: [] },
  }),
}));

// One day is deliberately PARTIAL (entryCount 3, one entry on this page) and one entry is
// BACK-DATED, so the two things this page must never hide -- truncation and late logging -- are both
// exercised by the render.
vi.mock("@/hooks/use-reports", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/use-reports")>("@/hooks/use-reports");
  return {
    ...actual,
    useDailyActivityLogReport: () => ({
      loading: false,
      error: null,
      data: {
        kpis: { totalEntries: 4, notes: 3, daysCovered: 2, repsLogging: 2, offDayLogged: 1 },
        days: [
          {
            date: "2026-06-02",
            entryCount: 3,
            noteCount: 2,
            repCount: 2,
            offDayLoggedCount: 1,
            entries: [
              {
                id: "act-late",
                type: "note",
                typeLabel: "Note",
                occurredAt: "2026-06-02T14:00:00.000Z",
                occurredDate: "2026-06-02",
                loggedAt: "2026-06-05T09:00:00.000Z",
                loggedDate: "2026-06-05",
                loggedSameDay: false,
                loggedDaysDiff: 3,
                responsibleUserId: "user-bob",
                responsibleName: "Bob Rep",
                performedByName: "Dana Director",
                subject: "Site visit writeup",
                body: "Wrote this up on Friday.",
                outcome: null,
                nextStep: "Send the scope",
                nextStepDueAt: null,
                durationMinutes: 45,
                targetType: "company",
                targetName: "Acme Property Group",
                dealId: null,
                dealName: null,
                dealNumber: null,
              },
            ],
          },
          {
            date: "2026-06-01",
            entryCount: 1,
            noteCount: 1,
            repCount: 1,
            offDayLoggedCount: 0,
            entries: [
              {
                id: "act-note",
                type: "note",
                typeLabel: "Note",
                occurredAt: "2026-06-01T15:00:00.000Z",
                occurredDate: "2026-06-01",
                loggedAt: "2026-06-01T15:05:00.000Z",
                loggedDate: "2026-06-01",
                loggedSameDay: true,
                loggedDaysDiff: 0,
                responsibleUserId: "user-alice",
                responsibleName: "Alice Rep",
                performedByName: null,
                subject: "Walked the roof with Jane",
                body: "Ponding on the north bay.",
                outcome: "connected",
                nextStep: null,
                nextStepDueAt: null,
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
        pagination: { page: 1, limit: 2, total: 4, returned: 2, totalPages: 2, hasMore: true },
        appliedTypes: [],
      },
    }),
  };
});

const { DailyActivityLogPage } = await import("./daily-activity-log-page");

function htmlFor(entry = "/reports/performance/daily-activity-log") {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[entry]}>
      <DailyActivityLogPage />
    </MemoryRouter>
  ).replace(/\s+/g, " ");
}

describe("DailyActivityLogPage", () => {
  it("renders the log shell, filters, KPIs and the type filter", () => {
    const html = htmlFor();

    expect(html).toContain("Daily Activity Log");
    expect(html).toContain("Report Filters");
    expect(html).toContain("Export to Excel");
    expect(html).toContain("Entries");
    expect(html).toContain("Logged Off-Day");
    // The type filter must offer note on its own -- that is the centrepiece of the ask.
    expect(html).toContain("All types");
    expect(html).toContain("Note");
    expect(html).toContain("Site Visit");
  });

  it("shows the readable entry content, not just counts", () => {
    const html = htmlFor();

    expect(html).toContain("Walked the roof with Jane");
    expect(html).toContain("Ponding on the north bay.");
    expect(html).toContain("Site visit writeup");
    expect(html).toContain("Alice Rep");
    expect(html).toContain("Bob Rep");
  });

  it("groups by day and surfaces a back-dated entry with the day it was actually logged", () => {
    const html = htmlFor();

    // Day headings are rendered from the OCCURRED date.
    expect(html).toContain("Monday, Jun 1, 2026");
    expect(html).toContain("Tuesday, Jun 2, 2026");
    // The late-logging badge names the gap and the logged date.
    expect(html).toContain("Logged 3d late");
    expect(html).toContain("Jun 5");
    expect(html).toContain("1 logged on another day");
    // A same-day entry must NOT be badged.
    expect(html).not.toContain("Logged 0d late");
  });

  it("names the performer only when someone else logged it", () => {
    const html = htmlFor();
    expect(html).toContain("logged by Dana Director");
    expect(html.match(/logged by/g)).toHaveLength(1);
  });

  it("links the deal and keeps the office scope on the link", () => {
    const html = htmlFor("/reports/performance/daily-activity-log?officeId=office-dallas");
    expect(html).toContain('href="/deals/deal-1?officeId=office-dallas"');
    expect(html).toContain("D-1001");
    // A non-deal entry names its target with the entity type instead of a link.
    expect(html).toContain("Acme Property Group");
    expect(html).toContain("company");
  });

  it("states the pagination range and total so a partial page cannot read as everything", () => {
    const html = htmlFor();

    // The range and the total are emphasised in spans, hence the markup in the match.
    expect(html).toContain("Showing <span class=\"font-bold text-slate-900\">1–2</span>");
    expect(html).toContain("<span class=\"font-bold text-slate-900\">4</span> entries");
    expect(html).toContain("page 1 of 2");
    expect(html).toContain("Excel export covers this page only");
    expect(html).toContain("Next");
    // The 06-02 day holds 3 entries but only 1 is on this page -- the header must say so.
    expect(html).toContain("showing 1 of them on this page");
  });
});
