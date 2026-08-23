// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

// THAT THE SHELL ACTUALLY SETS THE TITLE.
//
// `document-title.ts` decides what a route should be called and its own suite pins every case. This file
// exists because that is not the part that breaks. A correct decision module the screen never calls is a
// module that changes nothing — the same failure that shipped in #1094, where the right report id sat on
// the payload and the card asked for it in a branch that had stopped rendering.
//
// The shell's other tests use `renderToStaticMarkup`, which does not run effects, so none of them can see
// this. This one mounts the component for real.

const pathname = vi.hoisted(() => ({ current: "/deals" }));

vi.mock("@/hooks/use-platform-usage-tracker", () => ({
  usePlatformUsageTracker: () => undefined,
}));

vi.mock("react-router-dom", () => ({
  Outlet: () => <div data-slot="outlet" />,
  useLocation: () => ({ pathname: pathname.current }),
}));

vi.mock("./sidebar", () => ({ Sidebar: () => <aside /> }));
vi.mock("./topbar", () => ({ Topbar: () => <header /> }));
vi.mock("./mobile-nav", () => ({ MobileNav: () => <nav /> }));

// eslint-disable-next-line import/first
import { AppShell } from "./app-shell";

// `createRoot` + `act` rather than @testing-library/react, which the client does not depend on. `act`
// is what flushes the effect — the whole point of this file is that effects run.
let container: HTMLElement | null = null;
let root: Root | null = null;

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<AppShell />);
  });
}

function rerender() {
  act(() => {
    root!.render(<AppShell />);
  });
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("the shell titles the document", () => {
  it("sets the title from the current route on mount", () => {
    document.title = "untouched";
    pathname.current = "/companies";
    mount();
    expect(document.title).toBe("Companies · T Rock CRM");
  });

  it("re-titles when the route changes, not only on first mount", () => {
    // The effect is keyed on pathname. Keyed on [] instead, the first page a session lands on would name
    // every page after it — which reads as "titles work" right up until you navigate.
    document.title = "untouched";
    pathname.current = "/deals";
    mount();
    expect(document.title).toBe("Deals Dashboard · T Rock CRM");

    pathname.current = "/projects/weekly-reports";
    rerender();
    expect(document.title).toBe("Weekly Reports · T Rock CRM");
  });

  it("falls back to the bare app name on an unmapped route rather than leaving a stale one", () => {
    // A route with no entry must CLEAR the previous page's title, not inherit it. Leaving the old value
    // is worse than the static title this replaced: it actively misnames the page.
    document.title = "untouched";
    pathname.current = "/deals";
    mount();
    expect(document.title).toBe("Deals Dashboard · T Rock CRM");

    pathname.current = "/an/unmapped/route";
    rerender();
    expect(document.title).toBe("T Rock CRM");
  });
});
