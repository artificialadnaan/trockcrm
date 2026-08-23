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
 * Every internal route the sidebar links to — in BOTH shapes it uses.
 *
 * The nav is partly `{ to, label }` array entries and partly inline `<NavLink to="…">` JSX in the
 * hover-out submenus. Reading only the arrays missed `/projects/qc-reports`, `/projects/weekly-reports`
 * and `/projects/field-team` — three real pages, and the first version of this guard reported full
 * coverage while none of them had a title. A drift guard that sees one of two shapes is worse than none,
 * because it is believed.
 */
function sidebarRoutes(source: string): string[] {
  const fromArrays = [...source.matchAll(/\{\s*to:\s*"(\/[^"]*)"/g)].map((m) => m[1]!);
  const fromJsx = [...source.matchAll(/<NavLink\s+to="(\/[^"]*)"/g)].map((m) => m[1]!);
  return [...new Set([...fromArrays, ...fromJsx])];
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

  it("covers every internal route the sidebar links to", () => {
    // THE DRIFT GUARD, and the reason this is worth a test at all. The map is a second list of routes;
    // without this, adding a nav item silently reintroduces the untitled-tab bug for that page only —
    // the hardest kind to notice, because every other page looks fine.
    //
    // Parsed from the sidebar source rather than imported, because the nav arrays are module-private and
    // role-filtered at render time. External links (trockcam.com) are excluded: they leave the app.
    const source = fs.readFileSync(
      path.join(CLIENT_SRC, "components/layout/sidebar.tsx"),
      "utf8",
    );
    const navRoutes = sidebarRoutes(source);
    expect(navRoutes.length, "no nav routes parsed — the sidebar's shape changed").toBeGreaterThan(15);

    const missing = navRoutes.filter((route) => !(route in ROUTE_TITLES));
    expect(missing, "these sidebar routes have no page title").toEqual([]);
  });

  it("has no title entry for a route the sidebar does not have", () => {
    // The other direction: a stale entry is a title that can never render, and a map nobody prunes is a
    // map nobody trusts. Cheap to check while both lists are in hand.
    const source = fs.readFileSync(
      path.join(CLIENT_SRC, "components/layout/sidebar.tsx"),
      "utf8",
    );
    const navRoutes = new Set(sidebarRoutes(source));
    const orphans = Object.keys(ROUTE_TITLES).filter((route) => !navRoutes.has(route));
    expect(orphans, "these title entries point at routes the sidebar no longer links to").toEqual([]);
  });
});
