import { useEffect } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { titleForPath } from "@/lib/document-title";
import { usePlatformUsageTracker } from "@/hooks/use-platform-usage-tracker";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import { MobileNav } from "./mobile-nav";

export function AppShell() {
  usePlatformUsageTracker();
  const { pathname } = useLocation();

  // The tab, the history entry and the bookmark all read `document.title`, and nothing in this app ever
  // wrote it — so all three said "T Rock CRM" on every route. Set here rather than per page: the shell is
  // the one place that sees every navigation, and 30-odd pages each remembering to do it is 30 chances to
  // forget. `document-title.test.ts` pins the map against the sidebar so a new nav item cannot ship
  // untitled.
  useEffect(() => {
    document.title = titleForPath(pathname);
  }, [pathname]);

  return (
    <div className="flex min-h-screen bg-slate-100">
      {/*
        FIRST FOCUSABLE ELEMENT IN THE APP, and it has to stay first. Without it a keyboard user tabs
        through 32 controls — the whole sidebar plus Search and Notifications — before reaching the page,
        on EVERY navigation, because the nav re-enters the tab order each time the route changes. That is
        WCAG 2.2 SC 2.4.1 "Bypass Blocks", a Level A failure, and it applies to anyone driving by keyboard,
        switch device or voice — not only screen-reader users.

        `sr-only` keeps it out of the visual design at rest; `focus:not-sr-only` brings it back so a
        SIGHTED keyboard user can see what they are about to activate. Shipping only the first half is a
        link people trigger blind.
      */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:rounded-md focus:bg-slate-950 focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white focus:ring-2 focus:ring-brand-red"
      >
        Skip to main content
      </a>
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        {/*
          `tabIndex={-1}` is what makes the skip link actually work. Without it several browsers scroll
          this into view but leave focus on <body>, so the next Tab returns to the top of the nav — the
          link appears to have worked and has not. `outline-none` because this is a page-sized region: a
          ring around the entire content area reads as a rendering bug, and the region is not itself an
          interactive control.
        */}
        <main
          id="main-content"
          tabIndex={-1}
          className="flex-1 overflow-auto bg-slate-50 p-4 pb-20 outline-none md:p-6 md:pb-6"
        >
          {/* Named route-content frame keeps migrated routes on the inherited page rhythm while preserving full-height semantics during the shell rollout. */}
          <section data-slot="route-content-frame" className="min-h-full space-y-6">
            <Outlet />
          </section>
        </main>
      </div>
      <MobileNav />
    </div>
  );
}
