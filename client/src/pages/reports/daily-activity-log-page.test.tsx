// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, useLocation } from "react-router-dom";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
                contentRestricted: false,
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
                contentRestricted: false,
                durationMinutes: null,
                targetType: "deal",
                targetName: "Roof Replacement - Tower A",
                dealId: "deal-1",
                dealName: "Roof Replacement - Tower A",
                dealNumber: "D-1001",
              },
              {
                // Another user's email: server has already nulled the content and flagged the row.
                id: "act-email",
                type: "email",
                typeLabel: "Email",
                occurredAt: "2026-06-01T16:00:00.000Z",
                occurredDate: "2026-06-01",
                loggedAt: "2026-06-01T16:00:00.000Z",
                loggedDate: "2026-06-01",
                loggedSameDay: true,
                loggedDaysDiff: 0,
                responsibleUserId: "user-carol",
                responsibleName: "Carol Rep",
                performedByName: null,
                subject: null,
                body: null,
                outcome: null,
                nextStep: null,
                nextStepDueAt: null,
                contentRestricted: true,
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

/** Mounts the page for real (jsdom) so chip clicks run the actual handlers and rewrite the URL. */
function mountLog(initialEntry: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  function LocationProbe() {
    const location = useLocation();
    return <span data-testid="search">{location.search}</span>;
  }
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <DailyActivityLogPage />
        <LocationProbe />
      </MemoryRouter>
    );
  });
  return {
    search: () => container.querySelector("[data-testid='search']")?.textContent ?? "",
    clickChip(label: string) {
      const chip = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === label
      );
      if (!chip) throw new Error(`chip not found: ${label}`);
      act(() => {
        chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    },
    cleanup() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("DailyActivityLogPage paging staleness", () => {
  // Same failure mode as the shared filter bar: a page offset that outlives a filter change points at
  // the wrong slice of a different result set, and because the rows are real nothing looks broken.
  it("drops a stale page when a type chip is toggled", () => {
    const page = mountLog("/reports/performance/daily-activity-log?page=2&dateFrom=2026-06-01");
    try {
      expect(page.search()).toContain("page=2");
      page.clickChip("Note");
      expect(page.search()).toContain("types=note");
      expect(page.search()).not.toContain("page=");
      // An unrelated param the page did not touch must survive.
      expect(page.search()).toContain("dateFrom=2026-06-01");
    } finally {
      page.cleanup();
    }
  });

  it("drops a stale page when the type filter is cleared via All types", () => {
    const page = mountLog("/reports/performance/daily-activity-log?page=4&types=note");
    try {
      page.clickChip("All types");
      expect(page.search()).not.toContain("page=");
      expect(page.search()).not.toContain("types=");
    } finally {
      page.cleanup();
    }
  });

  it("keeps the page param when only paging", () => {
    // The reset must be scoped to FILTER changes -- Next/Previous obviously has to set it.
    const page = mountLog("/reports/performance/daily-activity-log?types=note");
    try {
      page.clickChip("Next");
      expect(page.search()).toContain("page=2");
      expect(page.search()).toContain("types=note");
    } finally {
      page.cleanup();
    }
  });
});

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

  it("labels a redacted email instead of rendering a blank entry", () => {
    const html = htmlFor();

    // The row is visible and attributed (so the counts make sense) but says why it has no content.
    expect(html).toContain("Carol Rep");
    expect(html).toContain("Email");
    expect(html).toContain("Content private");
    expect(html).toContain("still counted in the totals");
  });

  it("describes the filter from the server's appliedTypes, not the raw URL", () => {
    // A retired type in the URL is dropped by the server, which then returns ALL types. The page must
    // not claim the counts are filtered -- no chip lights up and no "Filtered to" caption appears.
    const html = htmlFor("/reports/performance/daily-activity-log?types=not_a_real_type");

    expect(html).not.toContain("Filtered to");
    // "All types" stays selected (dark chip) because nothing valid was requested.
    expect(html).toContain("border-slate-950 bg-slate-950 text-white\">All types");
  });

  it("discloses the Rep Activity cache window and the email redaction in the footnote", () => {
    const html = htmlFor();
    expect(html).toContain("caches for 5 minutes");
    expect(html).toContain("Email entries you do not own are counted but their content is not shown.");
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
