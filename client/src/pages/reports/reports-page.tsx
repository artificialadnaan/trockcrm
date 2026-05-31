import {
  Activity,
  BarChart3,
  BriefcaseBusiness,
  CalendarClock,
  ChartNoAxesCombined,
  ClipboardList,
  DollarSign,
  Gauge,
  LineChart,
  PieChart,
  ShieldAlert,
  TrendingUp,
  UserRound,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Link } from "react-router-dom";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import type { UserRole } from "@trock-crm/shared/types";

export function canViewDataMiningSection(role: UserRole | undefined) {
  return role === "director";
}

type ReportCard = {
  name: string;
  description: string;
  icon: LucideIcon;
  path?: string;
};

const reportCategories: Array<{ category: string; description: string; reports: ReportCard[] }> = [
  {
    category: "Showcase & Forecast",
    description: "Evidence-backed exec views — one source of truth, and every figure drills to the exact records behind it.",
    reports: [
      {
        name: "Monday Showcase",
        description: "8 variants (3 Report A + 4 Report B + exec hero) over identical canonical numbers — click any figure for its records.",
        icon: BarChart3,
        path: "/reports/monday-showcase",
      },
      {
        name: "Forecast Confidence Board",
        description: "The projection ladder made trustworthy — how much of the open book even has a maintained close date.",
        icon: Gauge,
        path: "/reports/forecast-confidence",
      },
      {
        name: "At-Risk Watchlist",
        description: "The forecast's blind spots: open deals with no maintained close date, or one already past.",
        icon: ShieldAlert,
        path: "/reports/at-risk",
      },
      {
        name: "Rep 1:1 Pack",
        description: "One rep across the board — Won/Sent/projection/leads + an 8-week trend, all drillable.",
        icon: UserRound,
        path: "/reports/rep-pack",
      },
    ],
  },
  {
    category: "Sales",
    description: "Pipeline, forecasts, close rates, and booked revenue.",
    reports: [
      { name: "Pipeline Velocity", description: "Stage movement, aging, and value trends.", icon: TrendingUp, path: "/reports/sales/pipeline-velocity" },
      { name: "Closed Won Revenue", description: "Booked revenue by rep, office, and period.", icon: DollarSign, path: "/reports/sales/closed-won-revenue" },
      { name: "Lead Conversion", description: "Lead source performance through contract.", icon: ChartNoAxesCombined, path: "/reports/sales/lead-conversion" },
    ],
  },
  {
    category: "Performance",
    description: "Director-facing scorecards and rep-level activity views.",
    reports: [
      { name: "Director Scorecard", description: "Executive view of targets, risk, and output.", icon: Gauge, path: "/reports/performance/director-scorecard" },
      { name: "Rep Activity", description: "Touchpoints, follow-ups, and stalled accounts.", icon: Activity, path: "/reports/performance/rep-activity" },
      { name: "Forecast Accuracy", description: "Commit, best case, and pipeline reliability.", icon: LineChart, path: "/reports/performance/forecast-accuracy" },
    ],
  },
  {
    category: "Operations",
    description: "Workflow health, due dates, handoffs, and closeout readiness.",
    reports: [
      {
        name: "Workflow Bottlenecks",
        description: "Aging by stage and blocked handoff counts.",
        icon: CalendarClock,
        path: "/reports/operations/workflow-bottlenecks",
      },
      {
        name: "Project Readiness",
        description: "Scoping, estimate, and kickoff completeness.",
        icon: ClipboardList,
        path: "/reports/operations/project-readiness",
      },
      {
        name: "Portfolio Load",
        description: "Active work grouped by company and property.",
        icon: BriefcaseBusiness,
        path: "/reports/operations/portfolio-load",
      },
    ],
  },
  {
    category: "Analytics",
    description: "Higher-level trends and business intelligence surfaces.",
    reports: [
      { name: "Market Mix", description: "Work by vertical, property type, and region.", icon: PieChart, path: "/reports/analytics/market-mix" },
      { name: "Customer Concentration", description: "Revenue and opportunity exposure by account.", icon: Users, path: "/reports/analytics/customer-concentration" },
      { name: "Executive Trends", description: "Multi-period summary of operating indicators.", icon: BarChart3, path: "/reports/analytics/executive-trends" },
    ],
  },
];

export function ReportsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Analytics"
        title="Reports"
        description="Report surfaces are being rebuilt as focused, icon-led views. Existing report backend endpoints remain available."
      />

      <section className="grid grid-cols-1 gap-4 md:grid-cols-4">
        {reportCategories.map((group) => (
          <Card key={group.category} className="relative overflow-hidden">
            <CardContent className="p-5">
              <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500">{group.category}</p>
              <div className="mt-3 text-4xl font-black tracking-tight text-slate-950">{group.reports.length}</div>
              <p className="mt-2 text-xs font-semibold text-slate-500">planned report surfaces</p>
            </CardContent>
            <div className="absolute inset-x-0 bottom-0 h-1 bg-brand-red" />
          </Card>
        ))}
      </section>

      <section className="space-y-5">
        {reportCategories.map((group) => (
          <div key={group.category} className="space-y-3">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500">{group.category}</p>
              <h2 className="mt-1 text-2xl font-black uppercase tracking-tight text-slate-950">{group.category} Reports</h2>
              <p className="mt-1 max-w-2xl text-sm text-slate-600">{group.description}</p>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              {group.reports.map((report) => {
                const Icon = report.icon;
                const content = (
                  <CardContent className="flex items-start gap-4 p-5">
                    <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-slate-950 text-white">
                      <Icon className="h-5 w-5" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-black uppercase tracking-tight text-slate-950">{report.name}</h3>
                        {report.path ? (
                          <span className="rounded-full bg-slate-950 px-2 py-1 text-[10px] font-black uppercase tracking-[0.14em] text-white">
                            Open
                          </span>
                        ) : (
                          <span className="rounded-full bg-red-50 px-2 py-1 text-[10px] font-black uppercase tracking-[0.14em] text-brand-red">
                            Coming soon
                          </span>
                        )}
                      </div>
                      <p className="mt-2 text-sm text-slate-600">{report.description}</p>
                    </div>
                  </CardContent>
                );

                return report.path ? (
                  <Card key={report.name} className="border-slate-200 bg-white transition hover:border-brand-red/40 hover:shadow-md">
                    <Link to={report.path} className="block focus:outline-none focus:ring-2 focus:ring-brand-red focus:ring-offset-2">
                      {content}
                    </Link>
                  </Card>
                ) : (
                  <Card key={report.name} className="border-slate-200 bg-white opacity-75">
                    {content}
                  </Card>
                );
              })}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
