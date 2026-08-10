// @vitest-environment jsdom
//
// The Daily Activity Log is limited to a named allowlist (DAILY_ACTIVITY_LOG_VIEWER_EMAILS). These cases pin
// the CLIENT half of that gate: the report index must not offer a card the viewer cannot open, and the
// category tally must agree with the grid beneath it. The server enforces the allowlist on the endpoint —
// hiding the card is courtesy, not the boundary.
//
// The RENDER cases below are the ones that matter. Testing visibleReportCategories alone proves the helper
// filters correctly but says nothing about whether the page USES it — swapping the render loops back to the
// unfiltered list left every assertion green while the card returned for everybody. That is the same gap the
// server side closed with daily-activity-log-route-guard.runtime.test.ts, so it is closed the same way here:
// by rendering the real component and asserting on its output.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

let authUser: { id: string; email: string; canViewDailyActivityLog?: boolean } | null = null;

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: authUser }),
}));

const { ReportsPage, visibleReportCategories } = await import("./reports-page");

const DAILY_ACTIVITY_LOG = "Daily Activity Log";
const LOG_PATH = "/reports/performance/daily-activity-log";

function render() {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/reports"]}>
      <ReportsPage />
    </MemoryRouter>
  ).replace(/\s+/g, " ");
}

function cardNames(ctx: Parameters<typeof visibleReportCategories>[0]) {
  return visibleReportCategories(ctx).flatMap((group) => group.reports.map((report) => report.name));
}

describe("ReportsPage — the rendered index", () => {
  it("offers the Daily Activity Log card to a flagged viewer", () => {
    authUser = { id: "u1", email: "tyamashita@trockgc.com", canViewDailyActivityLog: true };
    const html = render();

    expect(html).toContain(LOG_PATH);
    expect(html).toContain(DAILY_ACTIVITY_LOG);
  });

  it("renders NO link to the log for a viewer the server did not flag", () => {
    authUser = { id: "u2", email: "someadmin@trockgc.com", canViewDailyActivityLog: false };
    const html = render();

    expect(html).not.toContain(LOG_PATH);
    expect(html).not.toContain(DAILY_ACTIVITY_LOG);
    // Neighbouring Performance reports are untouched — this hides one card, not the category.
    expect(html).toContain("/reports/performance/rep-activity");
    expect(html).toContain("/reports/performance/forecast-accuracy");
  });

  it("treats an absent flag, and a signed-out render, as denied", () => {
    authUser = { id: "u3", email: "someone@trockgc.com" };
    expect(render()).not.toContain(LOG_PATH);

    authUser = null;
    expect(render()).not.toContain(LOG_PATH);
  });

  // The headline number on each category card is group.reports.length. Taken from the unfiltered list it
  // would advertise 5 Performance reports while rendering 4 — a tally that disagrees with its own grid.
  //
  // Asserted as the WHOLE ordered sequence of counts rather than "contains a 4": Sales and Operations also
  // have four cards each, so a bare toContain(">4</div>") passes whether or not Performance was filtered.
  it("counts the cards it actually renders, not the ones it knows about", () => {
    const countsInMarkup = (html: string) =>
      [...html.matchAll(/tracking-tight text-slate-950">(\d+)</g)].map((match) => Number(match[1]));

    authUser = { id: "u4", email: "someadmin@trockgc.com", canViewDailyActivityLog: false };
    const denied = countsInMarkup(render());

    authUser = { id: "u5", email: "tyamashita@trockgc.com", canViewDailyActivityLog: true };
    const allowed = countsInMarkup(render());

    // Same categories, and exactly one of them differs by exactly one card.
    expect(denied).toHaveLength(allowed.length);
    expect(allowed.map((n, i) => n - denied[i]!)).toEqual([0, 0, 1, 0, 0]);

    // And those tallies equal what the helper says the grid holds.
    expect(denied).toEqual(
      visibleReportCategories({ canViewDailyActivityLog: false }).map((group) => group.reports.length)
    );
    expect(allowed).toEqual(
      visibleReportCategories({ canViewDailyActivityLog: true }).map((group) => group.reports.length)
    );
  });
});

describe("visibleReportCategories", () => {
  it("offers the Daily Activity Log to a flagged viewer", () => {
    expect(cardNames({ canViewDailyActivityLog: true })).toContain(DAILY_ACTIVITY_LOG);
  });

  it("hides it from a viewer the server did not flag", () => {
    expect(cardNames({ canViewDailyActivityLog: false })).not.toContain(DAILY_ACTIVITY_LOG);
  });

  // An older client bundle, or a session minted before the flag existed, sends no flag at all. Absent must
  // read as "no" — the endpoint would 403 anyway, so offering the card would only produce a dead link.
  it("hides it when the flag is absent entirely", () => {
    expect(cardNames({})).not.toContain(DAILY_ACTIVITY_LOG);
    expect(cardNames({ canViewDailyActivityLog: undefined })).not.toContain(DAILY_ACTIVITY_LOG);
  });

  it("removes only that card — every other report still shows", () => {
    const allowed = cardNames({ canViewDailyActivityLog: true });
    const denied = cardNames({ canViewDailyActivityLog: false });
    expect(denied).toEqual(allowed.filter((name) => name !== DAILY_ACTIVITY_LOG));
    expect(denied).toContain("Rep Activity");
    expect(denied).toContain("Director Scorecard");
  });

  it("never returns an empty category", () => {
    for (const group of visibleReportCategories({ canViewDailyActivityLog: false })) {
      expect(group.reports.length).toBeGreaterThan(0);
    }
  });
});
