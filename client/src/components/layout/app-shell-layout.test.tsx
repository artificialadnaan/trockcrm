import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

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

describe("AppShell layout", () => {
  it("wraps routed content in a shared page stack container", () => {
    const html = normalize(renderToStaticMarkup(<AppShell />));

    expect(html).toContain(
      '<main class="flex-1 overflow-auto bg-slate-50 p-4 pb-20 md:p-6 md:pb-6">',
    );
    expect(html).toContain('data-slot="route-content-frame"');
    expect(html).toContain('class="min-h-full space-y-6"');
    expect(html).toContain('<section');
    expect(html).toContain('data-slot="outlet"');
    expect(html).toContain('aria-label="Search"');
    expect(html).toContain('data-slot="notification-center"');
    expect(html.indexOf('data-slot="route-content-frame"')).toBeLessThan(
      html.indexOf('data-slot="outlet"'),
    );
  });
});
