// @vitest-environment jsdom
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// THIRTY-TWO TAB PRESSES TO REACH THE PAGE.
//
// Measured on production at 1440px: every route in the CRM puts 32 focusable elements ahead of `<main>` —
// 30 in the sidebar plus Search and Notifications — and there is no way past them. A keyboard user pays
// that on EVERY navigation, because the sidebar re-enters the tab order each time the page changes.
//
// That is WCAG 2.2 SC 2.4.1 "Bypass Blocks", a Level A failure, and it is an app-shell defect rather than
// a page one: the same 32 stops sit in front of `/deals`, `/companies`, `/projects/weekly-reports` and
// everything else. Somebody navigating by keyboard — including anyone using a switch device or voice
// control, not only screen-reader users — cannot get to the content without traversing the whole nav.
//
// WHAT ACTUALLY MAKES A SKIP LINK WORK, and each of these is a way to ship one that does nothing:
//   * it must be the FIRST focusable element, or the user has already tabbed past the nav before they
//     reach it;
//   * its target must EXIST, or the browser moves focus nowhere and the link is decorative;
//   * the target must be focusable (`tabIndex={-1}`), or focus stays on `<body>` in several browsers and
//     the next Tab returns to the top of the nav — the link appears to work and does not;
//   * it must be VISIBLE when focused, or a sighted keyboard user cannot see what they are activating.
//
// So this parses the rendered shell and checks the ORDER, rather than asserting the markup contains a
// string. `sr-only` alone would satisfy a substring check and leave the link permanently invisible.
//
// The nav stand-ins below carry focusable children on purpose: with an empty `<aside />` the ordering
// assertion would pass no matter where the skip link went, which is the failure mode this file guards.

vi.mock("@/hooks/use-platform-usage-tracker", () => ({
  usePlatformUsageTracker: () => undefined,
}));

vi.mock("react-router-dom", () => ({
  Outlet: () => <div data-slot="outlet" />,
  useLocation: () => ({ pathname: "/deals" }),
}));

vi.mock("./sidebar", () => ({
  Sidebar: () => (
    <aside data-slot="sidebar">
      <a href="/deals">Deals</a>
      <a href="/companies">Companies</a>
      <a href="/contacts">Contacts</a>
    </aside>
  ),
}));

vi.mock("./topbar", () => ({
  Topbar: () => (
    <header data-slot="topbar">
      <button type="button" aria-label="Search">
        search
      </button>
      <button type="button" aria-label="Notifications">
        bell
      </button>
    </header>
  ),
}));

vi.mock("./mobile-nav", () => ({
  MobileNav: () => (
    <nav data-slot="mobile-nav">
      <a href="/">Home</a>
    </nav>
  ),
}));

// eslint-disable-next-line import/first
import { AppShell } from "./app-shell";

const FOCUSABLE =
  'a[href], button, input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"])';

function shell(): Document {
  const html = renderToStaticMarkup(<AppShell />);
  return new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
}

function describeNode(el: Element | null | undefined): string {
  if (!el) return "(none)";
  const label = el.getAttribute("aria-label") || (el.textContent || "").trim().slice(0, 24);
  return `${el.tagName.toLowerCase()}[${label}]`;
}

describe("a keyboard user can reach the page without traversing the nav", () => {
  it("puts the skip link FIRST in the focus order, ahead of every nav control", () => {
    // THE WHOLE POINT. A skip link placed after the sidebar is decorative: by the time it is reachable the
    // user has already paid the cost it exists to avoid.
    const doc = shell();
    const focusable = Array.from(doc.querySelectorAll(FOCUSABLE));
    expect(focusable.length, "no focusable elements rendered — the stand-ins are wrong").toBeGreaterThan(4);

    const first = focusable[0]!;
    expect(
      first.getAttribute("href"),
      `first focusable element is ${describeNode(first)}, not the skip link`,
    ).toBe("#main-content");
  });

  it("points at a target that actually exists", () => {
    // A skip link to a missing id moves focus nowhere at all, silently.
    const doc = shell();
    const target = doc.querySelector("#main-content");
    expect(target, "nothing in the shell has id=main-content").not.toBeNull();
    expect(target!.tagName.toLowerCase()).toBe("main");
  });

  it("makes that target focusable, so focus really lands there", () => {
    // `tabIndex={-1}` is the part everyone omits. Without it several browsers scroll the element into
    // view but leave focus on <body>, so the NEXT Tab goes back to the top of the nav — the link looks
    // like it worked and did nothing.
    const doc = shell();
    expect(doc.querySelector("#main-content")!.getAttribute("tabindex")).toBe("-1");
  });

  it("is hidden until focused, and visible once it is", () => {
    // Both halves matter. Permanently visible is a design regression on every page; permanently hidden is
    // a link a sighted keyboard user activates blind. `sr-only` + a `focus:` reveal is the standard pair,
    // and a substring check for `sr-only` alone would pass the broken version.
    const doc = shell();
    const link = doc.querySelector('a[href="#main-content"]')!;
    const classes = (link.getAttribute("class") || "").split(/\s+/);
    expect(classes, "the skip link is not visually hidden at rest").toContain("sr-only");
    expect(
      classes.some((c) => /^focus(-visible)?:not-sr-only$/.test(c)),
      "the skip link never becomes visible on focus",
    ).toBe(true);
  });

  it("leaves the rest of the shell's focus order alone", () => {
    // The fix must not reorder anything else. Sidebar before topbar before main is the existing reading
    // order, and a skip link is meant to be an escape hatch, not a re-layout.
    const doc = shell();
    const order = Array.from(doc.querySelectorAll(FOCUSABLE)).map((el) => {
      if (el.getAttribute("href") === "#main-content") return "skip";
      if (el.closest("[data-slot=sidebar]")) return "sidebar";
      if (el.closest("[data-slot=topbar]")) return "topbar";
      if (el.closest("[data-slot=mobile-nav]")) return "mobile-nav";
      return "other";
    });
    expect(order[0]).toBe("skip");
    expect(order.indexOf("sidebar")).toBeLessThan(order.indexOf("topbar"));
  });
});
