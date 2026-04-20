import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import dealsPageSource from "../../pages/deals/deal-list-page.tsx?raw";
import contactsPageSource from "../../pages/contacts/contact-list-page.tsx?raw";
import repDashboardSource from "../../pages/dashboard/rep-dashboard-page.tsx?raw";

vi.mock("react-router-dom", () => ({
  Outlet: () => <span data-slot="outlet">Route content</span>,
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: {
      displayName: "Test User",
    },
  }),
}));

vi.mock("@/components/notifications/notification-center", () => ({
  NotificationCenter: () => <div data-slot="notification-center" />,
}));

vi.mock("@/components/ui/avatar", () => ({
  Avatar: ({ children }: { children?: ReactNode }) => (
    <div data-slot="avatar">{children}</div>
  ),
  AvatarFallback: ({ children }: { children?: ReactNode }) => (
    <span data-slot="avatar-fallback">{children}</span>
  ),
}));

vi.mock("@/components/search/command-palette", () => ({
  CommandPalette: () => null,
}));

vi.mock("./sidebar", () => ({
  Sidebar: () => <aside data-slot="sidebar" />,
}));

vi.mock("./mobile-nav", () => ({
  MobileNav: () => <nav data-slot="mobile-nav" />,
}));

import { AppShell } from "./app-shell";

function normalize(html: string) {
  return html.replace(/\s+/g, " ").trim();
}

function getClassList(html: string, pattern: RegExp) {
  const match = html.match(pattern);

  expect(match).not.toBeNull();
  return match![1].split(/\s+/).filter(Boolean);
}

describe("AppShell layout", () => {
  it("wraps routed content in a shared page stack container", () => {
    const html = normalize(renderToStaticMarkup(<AppShell />));
    const mainClasses = getClassList(html, /<main[^>]*class="([^"]+)"/);
    const frameClasses = getClassList(
      html,
      /<section[^>]*data-slot="route-content-frame"[^>]*class="([^"]+)"/,
    );

    expect(html).toContain('data-slot="route-content-frame"');
    expect(html).toContain('<section');
    expect(html).toContain('data-slot="outlet"');
    expect(html).toContain('aria-label="Search"');
    expect(html).toContain('data-slot="notification-center"');
    expect(mainClasses).toEqual(
      expect.arrayContaining([
        "flex-1",
        "overflow-auto",
        "bg-slate-50",
        "p-4",
        "pb-20",
        "md:p-6",
        "md:pb-6",
      ]),
    );
    expect(frameClasses).toEqual(
      expect.arrayContaining(["min-h-full", "space-y-6"]),
    );
    expect(html.indexOf('data-slot="route-content-frame"')).toBeLessThan(
      html.indexOf('data-slot="outlet"'),
    );
  });

  it("migrates the rep dashboard, deals, and contacts to PageHeader", () => {
    expect(repDashboardSource).toContain(
      'import { PageHeader } from "@/components/layout/page-header";',
    );
    expect(repDashboardSource).toContain("<PageHeader");
    expect(repDashboardSource).not.toContain("<h2");
    expect(repDashboardSource).not.toContain("max-w-");
    expect(dealsPageSource).toContain(
      'import { PageHeader } from "@/components/layout/page-header";',
    );
    expect(dealsPageSource).toContain("<PageHeader");
    expect(dealsPageSource).toContain("<DealFilters");
    expect(dealsPageSource.indexOf("<PageHeader")).toBeLessThan(
      dealsPageSource.indexOf("<DealFilters"),
    );
    expect(dealsPageSource).not.toContain('<h2 className="text-2xl font-bold">Deals</h2>');
    expect(dealsPageSource).not.toContain("max-w-");
    expect(dealsPageSource).not.toContain("p-6");
    expect(contactsPageSource).toContain(
      'import { PageHeader } from "@/components/layout/page-header";',
    );
    expect(contactsPageSource).toContain("<PageHeader");
    expect(contactsPageSource).toContain("<ContactFilters");
    expect(contactsPageSource.indexOf("<PageHeader")).toBeLessThan(
      contactsPageSource.indexOf("<ContactFilters"),
    );
    expect(contactsPageSource).not.toContain('<h2 className="text-2xl font-bold">Contacts</h2>');
    expect(contactsPageSource).not.toContain("max-w-");
    expect(contactsPageSource).not.toContain("p-6");
  });
});
