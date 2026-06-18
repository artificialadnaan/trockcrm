import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import repDashboardSource from "../../pages/dashboard/rep-dashboard-page.tsx?raw";
import usersPageSource from "../../pages/admin/users-page.tsx?raw";

const dashboardState = vi.hoisted(() => ({
  loading: false,
  error: null as string | null,
  data: {
    activeLeads: { count: 4 },
    funnelBuckets: [
      { key: "lead", label: "Leads", count: 4, totalValue: null, route: "/leads", bucket: "lead" },
      { key: "qualified_lead", label: "Qualified Leads", count: 2, totalValue: null, route: "/leads", bucket: "qualified_lead" },
      { key: "opportunity", label: "Opportunities", count: 2, totalValue: 75000, route: "/leads", bucket: "opportunity" },
      { key: "estimating", label: "Bid Board", count: 1, totalValue: 250000, route: "/deals", bucket: "estimating" },
    ],
    staleLeads: { count: 1, averageDaysInStage: 16, leads: [] },
    activeDeals: { count: 3, totalValue: 123456 },
    contractsSignedYtd: { count: 0, totalValue: 0 },
    contractsSignedMtd: { count: 0, totalValue: 0 },
    tasksToday: { overdue: 1, today: 2 },
    activityThisWeek: { total: 7, calls: 2, emails: 3, meetings: 1, notes: 1 },
    followUpCompliance: { complianceRate: 85, onTime: 6, total: 7 },
    pipelineByStage: [{ stageId: "discovery", totalValue: 1000 }],
    leadSnapshot: [
      {
        leadId: "lead-1",
        leadName: "Lead One",
        companyName: "Birchstone",
        propertyName: "North Tower",
        stageName: "Discovery",
        daysInStage: 5,
        updatedAt: "2026-04-20T00:00:00.000Z",
      },
    ],
    dealSnapshot: [
      {
        dealId: "deal-1",
        dealName: "Deal One",
        companyName: "Birchstone",
        propertyName: "North Tower",
        stageName: "Estimating",
        totalValue: 250000,
        updatedAt: "2026-04-20T00:00:00.000Z",
      },
    ],
    myCleanup: { total: 1, byReason: [{ reasonCode: "missing_owner", count: 1 }] },
    commissionSummary: {
      directEarnedCommission: 1000,
      totalEarnedCommission: 1200,
    },
    downstreamBottlenecks: [],
  },
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
  // usePlatformUsageTracker reads location.pathname/search in an effect dep array during render.
  useLocation: () => ({ pathname: "/", search: "" }),
  Link: ({ to, children, className }: { to: string; children?: ReactNode; className?: string }) => (
    <a href={to} className={className}>{children}</a>
  ),
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

vi.mock("@/hooks/use-sales-review", () => ({
  useSalesReview: () => ({
    data: {
      hygiene: [{ issueTypes: ["unassigned_owner"] }],
    },
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

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock("@/components/ui/button", () => ({
  buttonVariants: ({ variant, size, className }: { variant?: string; size?: string; className?: string } = {}) =>
    ["mock-button", variant, size, className].filter(Boolean).join(" "),
  Button: ({
    children,
    onClick,
  }: {
    children?: ReactNode;
    onClick?: () => void;
  }) => <button onClick={onClick}>{children}</button>,
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

  it("keeps the rep dashboard on the preview surface inside the shared shell", () => {
    expect(repDashboardSource).not.toContain(
      'import { PageHeader } from "@/components/layout/page-header";',
    );
    expect(repDashboardSource).toContain("WELCOME, {firstName}");
    expect(repDashboardSource).toContain("TOP DEALS");
    expect(repDashboardSource).toContain("STRATEGIC ALERTS");
    expect(repDashboardSource).toContain("AI BLIND SPOTS");
    expect(repDashboardSource).toContain("MY NUMBERS");

    dashboardState.loading = true;
    dashboardState.error = null;
    let loadingMarkup = normalize(renderToStaticMarkup(<RepDashboardPage />));
    expect(loadingMarkup).toContain("WELCOME, TEST");
    expect(loadingMarkup).toContain("TODAY&#x27;S WORK");
    expect(loadingMarkup).toContain("animate-pulse");

    dashboardState.loading = false;
    dashboardState.error = "boom";
    let errorMarkup = normalize(renderToStaticMarkup(<RepDashboardPage />));
    expect(errorMarkup).toContain("WELCOME, TEST");
    expect(errorMarkup).toContain("DASHBOARD UNAVAILABLE");
    expect(errorMarkup).toContain("boom");

    dashboardState.error = null;
    let successMarkup = normalize(renderToStaticMarkup(<RepDashboardPage />));
    expect(successMarkup).toContain("WELCOME, TEST");
    expect(successMarkup).toContain("ACTIVE DEALS");
    expect(successMarkup).toContain("TOP DEALS");
    expect(successMarkup).toContain("STRATEGIC ALERTS");
    expect(successMarkup).toContain("AI BLIND SPOTS");
    expect(successMarkup).toContain("MY NUMBERS");
    expect(successMarkup).toContain("Open my pipeline");

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
    expect(usersPageSource).toContain("Preview");
    expect(usersPageSource).toContain("History");
    expect(usersPageSource).toContain("Revoke");
    expect(usersPageSource).toContain("<UserInvitePreviewDialog");
    expect(usersPageSource).toContain("<UserLocalAuthEventsDialog");
  });
});
