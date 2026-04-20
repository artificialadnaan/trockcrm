import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import dealsPageSource from "../../pages/deals/deal-list-page.tsx?raw";
import contactsPageSource from "../../pages/contacts/contact-list-page.tsx?raw";
import repDashboardSource from "../../pages/dashboard/rep-dashboard-page.tsx?raw";
import usersPageSource from "../../pages/admin/users-page.tsx?raw";

const dashboardState = vi.hoisted(() => ({
  loading: false,
  error: null as string | null,
  data: {
    activeDeals: { count: 3, totalValue: 123456 },
    tasksToday: { overdue: 1, today: 2 },
    activityThisWeek: { total: 7, calls: 2, emails: 3, meetings: 1, notes: 1 },
    followUpCompliance: { complianceRate: 85, onTime: 6, total: 7 },
    pipelineByStage: [{ stageId: "discovery", totalValue: 1000 }],
  },
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
  Outlet: () => <span data-slot="outlet">Route content</span>,
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: {
      displayName: "Test User",
    },
  }),
}));

vi.mock("@/hooks/use-dashboard", () => ({
  useRepDashboard: () => ({
    data: dashboardState.data,
    loading: dashboardState.loading,
    error: dashboardState.error,
  }),
}));

vi.mock("@/hooks/use-tasks", () => ({
  useTasks: ({ section }: { section: "overdue" | "today" }) => ({
    tasks: section === "overdue" ? [{ id: "task-1" }] : [{ id: "task-2" }],
    refetch: vi.fn(),
  }),
}));

vi.mock("@/components/layout/page-header", () => ({
  PageHeader: ({
    title,
    description,
    meta,
  }: {
    title: string;
    description?: string;
    meta?: string;
  }) => (
    <header data-slot="page-header">
      <h1>{title}</h1>
      {description ? <p>{description}</p> : null}
      {meta ? <p>{meta}</p> : null}
    </header>
  ),
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({
    children,
    className,
  }: {
    children?: ReactNode;
    className?: string;
  }) => <section className={className}>{children}</section>,
  CardContent: ({
    children,
    className,
  }: {
    children?: ReactNode;
    className?: string;
  }) => <div className={className}>{children}</div>,
  CardHeader: ({
    children,
    className,
  }: {
    children?: ReactNode;
    className?: string;
  }) => <header className={className}>{children}</header>,
  CardTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("@/components/dashboard/stat-card", () => ({
  StatCard: ({ title }: { title: string }) => <div>{title}</div>,
}));

vi.mock("@/components/charts/pipeline-bar-chart", () => ({
  PipelineBarChart: () => <div data-slot="pipeline-chart" />,
}));

vi.mock("@/components/charts/chart-colors", () => ({
  formatCurrency: (value: number) => `$${value.toLocaleString()}`,
}));

vi.mock("@/components/tasks/task-section", () => ({
  TaskSection: ({ title }: { title: string }) => <div>{title}</div>,
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
import { RepDashboardPage } from "../../pages/dashboard/rep-dashboard-page";

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
    expect(repDashboardSource).toContain(
      "title={`Welcome back, ${firstName}`}",
    );
    expect(repDashboardSource).toContain(
      "description={`Here is your sales activity overview for ${currentYear}.`}",
    );
    expect(repDashboardSource).not.toContain("<h2");

    dashboardState.loading = true;
    dashboardState.error = null;
    let loadingMarkup = normalize(renderToStaticMarkup(<RepDashboardPage />));
    expect(loadingMarkup).toContain('data-slot="page-header"');
    expect(loadingMarkup).toContain("Welcome back, Test");
    expect(loadingMarkup).toContain("Here is your sales activity overview for");
    expect(loadingMarkup).toContain("animate-pulse");

    dashboardState.loading = false;
    dashboardState.error = "boom";
    let errorMarkup = normalize(renderToStaticMarkup(<RepDashboardPage />));
    expect(errorMarkup).toContain('data-slot="page-header"');
    expect(errorMarkup).toContain("Welcome back, Test");
    expect(errorMarkup).toContain("Here is your sales activity overview for");
    expect(errorMarkup).toContain("boom");

    dashboardState.error = null;
    let successMarkup = normalize(renderToStaticMarkup(<RepDashboardPage />));
    expect(successMarkup).toContain('data-slot="page-header"');
    expect(successMarkup).toContain("Welcome back, Test");
    expect(successMarkup).toContain("Here is your sales activity overview for");
    expect(successMarkup).toContain("Today&#x27;s Tasks");
    expect(successMarkup).toContain("My Pipeline");
    expect(successMarkup).toContain("Activity This Week");

    expect(dealsPageSource).toContain(
      'import { PageHeader } from "@/components/layout/page-header";',
    );
    expect(dealsPageSource).toContain("<PageHeader");
    expect(dealsPageSource).toContain("<DealFilters");
    expect(dealsPageSource.indexOf("<PageHeader")).toBeLessThan(
      dealsPageSource.indexOf("<DealFilters"),
    );
    expect(dealsPageSource).not.toContain('<h2 className="text-2xl font-bold">Deals</h2>');
    expect(dealsPageSource).not.toContain('className="flex items-center justify-between"');
    expect(dealsPageSource).not.toContain('className="space-y-4"');

    expect(contactsPageSource).toContain(
      'import { PageHeader } from "@/components/layout/page-header";',
    );
    expect(contactsPageSource).toContain("<PageHeader");
    expect(contactsPageSource).toContain("<ContactFilters");
    expect(contactsPageSource.indexOf("<PageHeader")).toBeLessThan(
      contactsPageSource.indexOf("<ContactFilters"),
    );
    expect(contactsPageSource).not.toContain('<h2 className="text-2xl font-bold">Contacts</h2>');
    expect(contactsPageSource).not.toContain(
      'className="flex items-center justify-between"',
    );
    expect(contactsPageSource).not.toContain('className="space-y-4"');
  });

  it("migrates the admin users page to PageHeader and the shared management wrapper", () => {
    expect(usersPageSource).toContain(
      'import { PageHeader } from "@/components/layout/page-header";',
    );
    expect(usersPageSource).toContain("<PageHeader");
    expect(usersPageSource).not.toContain(
      '<h1 className="text-2xl font-semibold text-gray-900">Users</h1>',
    );
    expect(usersPageSource).not.toContain(
      'className="p-6 space-y-6 max-w-5xl mx-auto"',
    );
    expect(usersPageSource).toContain('className="mx-auto max-w-6xl space-y-6"');
    expect(usersPageSource).toContain('placeholder="Search by name or email"');
    expect(usersPageSource).toContain("Make director");
  });
});
