import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { APP_NAME, ROUTE_TITLES, titleForPath } from "./document-title";

// EVERY TAB IN THE CRM SAYS "T ROCK CRM".
//
// `client/index.html` sets a static `<title>` and nothing in the app has ever written `document.title` —
// verified by grep, and verified by navigating: /deals, /companies, /contacts, /files, /reports,
// /projects/weekly-reports, /director/commissions and /reports/monday-showcase all report the identical
// title on a real page load.
//
// WCAG 2.2 SC 2.4.2 "Page Titled" is Level A, but the compliance framing undersells this one. The title is
// the name of the browser tab, the history entry, and the bookmark. Somebody working a deal with the
// company, the property and the weekly report open in four tabs has four tabs that read the same thing,
// a back-history of identical entries, and no way to tell them apart without clicking. For a screen
// reader the title is what is announced on navigation, so an unchanged title is silence where the
// confirmation should be.
//
// SCOPE, STATED. This gives every NAV route a title. A detail route like `/companies/:id` inherits its
// section's title — "Companies · T Rock CRM" — which differentiates sections but not records. Putting the
// record's name in the title needs each page to publish it and is deliberately not in this change; the
// prefix match is what makes that a later refinement rather than a rewrite.

const CLIENT_SRC = path.resolve(__dirname, "..");

/**
 * Every STATIC route the router renders inside `AppShell` — the authoritative list.
 *
 * NOT the sidebar. That was the first version and it covers what people click, not what the router
 * serves: `/search`, `/sales-review`, `/dashboard/contracts-signed` and `/pipeline/hygiene` are real
 * pages with no nav entry, and every `/reports/...` page is reachable without one. Checking the map
 * against the nav declared full coverage while those had no title.
 *
 * Scoped to routes INSIDE the shell, because the title effect lives there: `/reset-password`, `/p/:token`
 * and the other pre-shell routes are served by a different tree and are out of this map's remit.
 *
 * Parameterised routes are excluded — they inherit their section by prefix, which is the design.
 */
function routerRoutes(source: string): string[] {
  const shellAt = source.indexOf("<Route element={<AppShell />}>");
  expect(shellAt, "the AppShell route boundary moved — this guard is reading the wrong span").toBeGreaterThan(-1);
  const inShell = source.slice(shellAt);
  return [...new Set([...inShell.matchAll(/path="(\/[^"]*)"/g)].map((m) => m[1]!))]
    .filter((route) => !route.includes(":"))
    .filter((route) => !route.startsWith("/__harness__"));
}

describe("a page says what it is", () => {
  it("names the page first, then the app", () => {
    // Page-first, because a tab strip truncates from the RIGHT. "T Rock CRM · Deals" collapses to
    // "T Rock CR…" on every tab and is exactly as useless as what it replaced.
    expect(titleForPath("/deals")).toBe(`Deals Dashboard · ${APP_NAME}`);
  });

  it("falls back to the app name alone on a route it does not know", () => {
    expect(titleForPath("/some/unmapped/route")).toBe(APP_NAME);
  });

  it("gives a detail route its section's title rather than nothing", () => {
    // `/companies/abc123` is not in the map. Longest-prefix match keeps it meaningful instead of falling
    // all the way back to the bare app name.
    expect(titleForPath("/companies/abc-123")).toBe(`Companies · ${APP_NAME}`);
  });

  it("prefers the MOST specific route, not the first that matches", () => {
    // `/projects` and `/projects/weekly-reports` both prefix-match the latter. Ordering the map by
    // specificity is the kind of thing that works until someone appends a new entry, so it is asserted.
    expect(titleForPath("/projects/weekly-reports")).toBe(`Weekly Reports · ${APP_NAME}`);
    expect(titleForPath("/projects")).toBe(`Projects · ${APP_NAME}`);
  });

  it("does not let /deals swallow /deals-something", () => {
    // A naive `startsWith` matches `/dealsomething`. The boundary has to be a segment boundary.
    expect(titleForPath("/dealsroom")).toBe(APP_NAME);
    expect(titleForPath("/deals/pending-rfp")).toBe(`Pending RFP · ${APP_NAME}`);
  });

  it("titles the root route", () => {
    // `/` prefix-matches literally everything, so it is the one entry that must be exact-match only.
    expect(titleForPath("/")).toBe(`Dashboard · ${APP_NAME}`);
  });

  it.each([
    ["/search", "Search"],
    ["/sales-review", "Sales Review"],
    ["/dashboard/contracts-signed", "Contracts Signed"],
    ["/pipeline/hygiene", "Pipeline Hygiene"],
    ["/reports/monday-showcase", "Monday Showcase"],
    ["/reports/performance/director-scorecard", "Director Scorecard"],
    ["/reports/sales/closed-won-revenue", "Closed-Won Revenue"],
  ])("names %s specifically, not by its section", (route, name) => {
    // The exact routes the first version got wrong. Four had no nav entry so the sidebar-based map missed
    // them entirely, and the /reports/... pages all collapsed into a shared "Reports" — twenty-odd
    // distinct tabs reading identically, which is the defect this change exists to remove. Pinned by
    // name so a future map edit cannot quietly re-merge them.
    expect(titleForPath(route)).toBe(`${name} · ${APP_NAME}`);
  });

  it("covers every static page the router renders inside the shell", () => {
    // THE DRIFT GUARD, and the reason this is worth a test at all. The map is a second list of routes;
    // without it, adding a page silently reintroduces the untitled-tab bug for that page only — the
    // hardest kind to notice, because every other page looks fine.
    //
    // Read from App.tsx because the ROUTER is what decides which pages exist. Checking against the
    // sidebar instead — the first version — passed while /search, /sales-review and every
    // /reports/... sub-page went untitled, because none of them is a nav destination.
    const source = fs.readFileSync(path.join(CLIENT_SRC, "App.tsx"), "utf8");
    const routes = routerRoutes(source);
    expect(routes.length, "no routes parsed — App.tsx's shape changed").toBeGreaterThan(50);

    const missing = routes.filter((route) => !(route in ROUTE_TITLES));
    expect(missing, "these routed pages have no page title").toEqual([]);
  });

  it("has no title entry for a route the router does not serve", () => {
    // The other direction: a stale entry is a title that can never render, and a map nobody prunes is a
    // map nobody trusts. Cheap to check while both lists are in hand.
    const source = fs.readFileSync(path.join(CLIENT_SRC, "App.tsx"), "utf8");
    const routes = new Set(routerRoutes(source));
    const orphans = Object.keys(ROUTE_TITLES).filter((route) => !routes.has(route));
    expect(orphans, "these title entries point at routes the router no longer serves").toEqual([]);
  });
});
