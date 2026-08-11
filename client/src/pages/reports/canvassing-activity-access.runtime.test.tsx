// @vitest-environment jsdom
//
// The Canvassing Activity report is a per-person scoreboard, limited to the CANVASSING_REPORT_VIEWER_EMAILS
// allowlist. These cases pin the client half: a denied user sees an explanation, the report never mounts (so
// no request is fired at an endpoint that would 403), and the index does not offer a card that cannot open.
//
// The index cases RENDER the real component rather than calling the filter helper. Testing the helper alone
// proves it filters but says nothing about whether the page uses it — a page wired to the unfiltered list
// passes every helper assertion while offering the card to everybody.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

let authUser: { id: string; email: string; canViewCanvassingReport?: boolean } | null = null;

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: authUser }),
}));

// Counts every attempt to load the report. A denied render must leave this at zero.
const fetchReport = vi.fn();

vi.mock("@/components/reports/report-filter-bar", () => ({
  ReportFilterBar: () => <div>Report Filters</div>,
  useReportFilters: () => ({
    filters: { dateFrom: "2026-06-01", dateTo: "2026-06-30", office: "all", ownerIds: [], ownerNames: [] },
    query: { dateFrom: "2026-06-01", dateTo: "2026-06-30", office: "all", ownerIds: [], ownerNames: [] },
  }),
}));

vi.mock("@/hooks/use-reports", () => ({
  useCanvassingActivityReport: (options: unknown) => {
    fetchReport(options);
    return { data: null, loading: false, error: null };
  },
}));

const { CanvassingActivityPage } = await import("./canvassing-activity-page");
const { ReportsPage, visibleReportCategories } = await import("./reports-page");

const CARD = "Canvassing Activity";
const PATH = "/reports/performance/canvassing-activity";

function renderPage() {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[PATH]}>
      <CanvassingActivityPage />
    </MemoryRouter>
  );
}

function renderIndex() {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/reports"]}>
      <ReportsPage />
    </MemoryRouter>
  ).replace(/\s+/g, " ");
}

beforeEach(() => {
  fetchReport.mockClear();
  authUser = null;
});

describe("CanvassingActivityPage access gate", () => {
  it("explains the restriction and loads nothing for a user the server did not flag", () => {
    authUser = { id: "u1", email: "arep@trockgc.com", canViewCanvassingReport: false };
    const html = renderPage();

    expect(html).toContain("limited to designated viewers");
    expect(fetchReport).not.toHaveBeenCalled();
  });

  it("treats an absent flag and a signed-out render as denied", () => {
    authUser = { id: "u2", email: "someone@trockgc.com" };
    expect(renderPage()).toContain("limited to designated viewers");

    authUser = null;
    expect(renderPage()).toContain("limited to designated viewers");
    expect(fetchReport).not.toHaveBeenCalled();
  });

  it("renders the report and requests data for a flagged viewer", () => {
    authUser = { id: "u3", email: "cburling@trockgc.com", canViewCanvassingReport: true };
    const html = renderPage();

    expect(html).not.toContain("limited to designated viewers");
    expect(html).toContain("Report Filters");
    expect(fetchReport).toHaveBeenCalledTimes(1);
  });
});

describe("the report index", () => {
  it("offers the card to a flagged viewer", () => {
    authUser = { id: "u4", email: "cburling@trockgc.com", canViewCanvassingReport: true };
    const html = renderIndex();

    expect(html).toContain(PATH);
    expect(html).toContain(CARD);
  });

  it("renders no link to it for a viewer the server did not flag", () => {
    authUser = { id: "u5", email: "arep@trockgc.com", canViewCanvassingReport: false };
    const html = renderIndex();

    expect(html).not.toContain(PATH);
    expect(html).not.toContain(CARD);
    // One card is hidden, not the category.
    expect(html).toContain("/reports/performance/rep-activity");
  });

  it("treats an absent flag as denied — an older session predates the flag", () => {
    authUser = { id: "u6", email: "someone@trockgc.com" };
    expect(renderIndex()).not.toContain(PATH);
  });

  // The headline number on each category card is group.reports.length. Read off the unfiltered list it
  // would advertise a report the grid below does not show.
  it("counts the cards it actually renders", () => {
    const countsInMarkup = (html: string) =>
      [...html.matchAll(/tracking-tight text-slate-950">(\d+)</g)].map((match) => Number(match[1]));

    authUser = { id: "u7", email: "arep@trockgc.com", canViewCanvassingReport: false };
    const denied = countsInMarkup(renderIndex());

    authUser = { id: "u8", email: "cburling@trockgc.com", canViewCanvassingReport: true };
    const allowed = countsInMarkup(renderIndex());

    expect(denied).toHaveLength(allowed.length);
    // Exactly one category — Performance — gains exactly one card.
    expect(allowed.map((n, i) => n - denied[i]!)).toEqual([0, 0, 1, 0, 0]);

    expect(denied).toEqual(
      visibleReportCategories({ canViewCanvassingReport: false }).map((group) => group.reports.length)
    );
    expect(allowed).toEqual(
      visibleReportCategories({ canViewCanvassingReport: true }).map((group) => group.reports.length)
    );
  });
});
