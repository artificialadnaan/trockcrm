import {
  BarChart3,
  Bell,
  Camera,
  CheckSquare,
  LayoutDashboard,
  Kanban,
  RefreshCw,
  Ticket,
  User as UserIcon,
  Users,
} from "lucide-react";
import { Link } from "react-router-dom";
import { MobileNavView } from "@/components/layout/mobile-nav";
import { RepPerfCard, type RepPerfView } from "@/pages/director/director-dashboard-page";
import { ScopeToggle } from "@/components/shared/scope-toggle";
import { useState } from "react";

// Dev-only preview for the mobile UI refresh (bottom nav, responsive Sales Force
// table, touch targets). Mirrors the shared-primitives harness pattern: real
// components, mock data, no backend. View at /__harness__/mobile-ui (DEV only),
// 390px viewport, for before/after screenshots.

const mockRepViews: RepPerfView[] = [
  {
    repId: "r1",
    repName: "Caleb Stone",
    detailPath: "#",
    region: "Dallas North",
    needsHelp: false,
    closed: 1840000,
    closedDeals: 7,
    pipelineValue: 5200000,
    activeDeals: 14,
    winRate: 62,
    winDelta: 4,
    atRisk: 0,
    activity: { dot: "bg-emerald-500", label: "High" },
    distribution: { leads: 8, qualifiedLeads: 5, opportunities: 4, estimating: 3 },
    sparkline: [3, 5, 4, 6, 7, 6, 8, 9],
  },
  {
    repId: "r2",
    repName: "Maria Quinn",
    detailPath: "#",
    region: "Fort Worth",
    needsHelp: true,
    closed: 920000,
    closedDeals: 3,
    pipelineValue: 3100000,
    activeDeals: 9,
    winRate: 41,
    winDelta: -6,
    atRisk: 2,
    activity: { dot: "bg-amber-500", label: "Moderate" },
    distribution: { leads: 6, qualifiedLeads: 3, opportunities: 2, estimating: 1 },
    sparkline: [6, 5, 4, 4, 3, 3, 2, 2],
  },
  {
    repId: "r3",
    repName: "Devon Hart",
    detailPath: "#",
    region: "Performance pending",
    needsHelp: true,
    closed: null,
    closedDeals: null,
    pipelineValue: 780000,
    activeDeals: 4,
    winRate: null,
    winDelta: null,
    atRisk: 1,
    activity: { dot: "bg-gray-300", label: "Low" },
    distribution: undefined,
    sparkline: [],
  },
];

const legacyMobileBar = [
  { icon: LayoutDashboard, label: "Home" },
  { icon: Kanban, label: "Pipeline" },
  { icon: Camera, label: "Capture" },
  { icon: Users, label: "Contacts" },
  { icon: CheckSquare, label: "Tasks" },
  { icon: Ticket, label: "Tickets" },
];

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section data-testid={id} className="space-y-3">
      <h2 className="text-xs font-black uppercase tracking-widest text-slate-500">{title}</h2>
      {children}
    </section>
  );
}

function BeforeAfter({ before, after }: { before: React.ReactNode; after: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <div>
        <p className="mb-1 text-[10px] font-black uppercase tracking-widest text-red-600">Before</p>
        <div className="rounded-xl border border-dashed border-red-200 bg-white p-2">{before}</div>
      </div>
      <div>
        <p className="mb-1 text-[10px] font-black uppercase tracking-widest text-emerald-600">After</p>
        <div className="rounded-xl border border-emerald-200 bg-white p-2">{after}</div>
      </div>
    </div>
  );
}

export function MobileUiHarness() {
  const [scope, setScope] = useState("all");

  return (
    <div className="mx-auto max-w-md space-y-8 bg-[#F5F4F2] p-4 pb-28">
      <header>
        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Mobile UI refresh</p>
        <h1 className="mt-1 text-2xl font-black uppercase leading-none text-slate-950">Phone preview · 390px</h1>
      </header>

      <Section id="harness-nav" title="1 · Bottom nav (Deals + Leads + More)">
        <BeforeAfter
          before={
            <div className="flex items-center justify-around rounded-lg border-t bg-white py-1">
              {legacyMobileBar.map((item) => (
                <div key={item.label} className="flex min-w-[2.5rem] flex-col items-center gap-1 py-1 text-slate-400">
                  <item.icon className="h-5 w-5" />
                  <span className="text-[10px] font-medium">{item.label}</span>
                </div>
              ))}
            </div>
          }
          after={
            <p className="px-2 py-3 text-xs text-slate-500">
              Live bar pinned to the bottom of this viewport ↓ — primary tabs are{" "}
              <span className="font-bold text-slate-900">Home · Deals · Leads · Pipeline · More</span>. Tap{" "}
              <span className="font-bold text-slate-900">More</span> for Contacts, Tasks, Reports, Capture, Tickets, etc.
            </p>
          }
        />
      </Section>

      <Section id="harness-table" title="2 · Sales Force Performance — responsive cards (<md)">
        <p className="text-xs text-slate-500">
          The desktop view keeps the 980px table; below <code>md</code> it stacks into cards (no scroll wall).
        </p>
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="border-b border-gray-100 px-5 py-4">
            <h3 className="text-sm font-black uppercase tracking-wide text-gray-950">Sales Force Performance</h3>
            <p className="mt-1 text-xs text-gray-500">Tap a rep for the full breakdown</p>
          </div>
          {mockRepViews.map((view) => (
            <RepPerfCard key={view.repId} view={view} />
          ))}
        </div>
      </Section>

      <Section id="harness-tap-targets" title="3 · Touch targets (>=44px on phones)">
        <BeforeAfter
          before={
            <div className="flex flex-wrap items-center gap-2 p-2">
              <ScopeToggle
                options={[{ value: "mine", label: "Mine" }, { value: "all", label: "All" }]}
                value={scope}
                onChange={setScope}
                ariaLabel="Scope (compact)"
              />
              <span className="rounded-full bg-gray-200 px-3 py-1 text-xs font-black text-gray-600">MTD</span>
              <span className="rounded-full bg-gray-200 px-3 py-1 text-xs font-black text-gray-600">QTD</span>
            </div>
          }
          after={
            <div className="flex flex-wrap items-center gap-2 p-2">
              <ScopeToggle
                options={[{ value: "mine", label: "Mine" }, { value: "all", label: "All" }]}
                value={scope}
                onChange={setScope}
                ariaLabel="Scope (touch)"
                size="touch"
              />
              <span className="inline-flex min-h-[44px] items-center rounded-full bg-[#CC0000] px-4 py-2.5 text-sm font-black text-white">MTD</span>
              <span className="inline-flex min-h-[44px] items-center rounded-full bg-gray-200 px-4 py-2.5 text-sm font-black text-gray-600">QTD</span>
            </div>
          }
        />
      </Section>

      <Section id="harness-toolbar-stubs" title="4 · Rep dashboard header — dead controls fixed">
        <p className="text-xs text-slate-500">
          The chart &amp; bell icons used to be inert buttons with lying{" "}
          <code>aria-label</code>s. The chart icon now links to{" "}
          <code>/reports</code>. The bell is <strong>removed</strong> — the
          AppShell <code>Topbar</code> already mounts the canonical{" "}
          <code>NotificationCenter</code> on every viewport, so a second one here
          would be a redundant, divergent bell. Remaining controls stay ≥44px.
        </p>
        <BeforeAfter
          before={
            <div className="flex flex-wrap items-center gap-3 p-2">
              <button
                type="button"
                aria-label="Open charts"
                className="flex size-11 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 md:size-10"
              >
                <BarChart3 className="h-4 w-4" />
              </button>
              <button
                type="button"
                aria-label="Open notifications"
                className="relative flex size-11 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 md:size-10"
              >
                <Bell className="h-4 w-4" />
                <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-brand-red" />
              </button>
              <span className="text-[10px] font-bold uppercase text-red-600">inert · no onClick</span>
            </div>
          }
          after={
            <div className="flex flex-wrap items-center gap-3 p-2">
              <Link
                to="/reports"
                aria-label="View reports"
                className="flex size-11 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 md:size-10"
              >
                <BarChart3 className="h-4 w-4" />
              </Link>
              <button
                type="button"
                aria-label="Refresh dashboard"
                className="flex size-11 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 md:size-10"
              >
                <RefreshCw className="h-4 w-4" />
              </button>
              <button
                type="button"
                aria-label="Open profile"
                className="flex size-11 items-center justify-center rounded-full bg-brand-red text-white md:size-10"
              >
                <UserIcon className="h-4 w-4" />
              </button>
            </div>
          }
        />
      </Section>

      <MobileNavView role="rep" />
    </div>
  );
}
