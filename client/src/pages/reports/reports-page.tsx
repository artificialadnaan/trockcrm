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
  TrendingUp,
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
  href?: string;
};

const reportCategories: Array<{ category: string; description: string; reports: ReportCard[] }> = [
  {
    category: "Sales",
    description: "Pipeline, forecasts, close rates, and booked revenue.",
    reports: [
      { name: "Pipeline Velocity", description: "Stage movement, aging, and value trends.", icon: TrendingUp, href: "/reports/sales/pipeline-velocity" },
      { name: "Closed Won Revenue", description: "Booked revenue by rep, office, and period.", icon: DollarSign, href: "/reports/sales/closed-won-revenue" },
      { name: "Lead Conversion", description: "Lead source performance through contract.", icon: ChartNoAxesCombined, href: "/reports/sales/lead-conversion" },
    ],
  },
  {
    category: "Performance",
    description: "Director-facing scorecards and rep-level activity views.",
    reports: [
      { name: "Director Scorecard", description: "Executive view of targets, risk, and output.", icon: Gauge },
      { name: "Rep Activity", description: "Touchpoints, follow-ups, and stalled accounts.", icon: Activity },
      { name: "Forecast Accuracy", description: "Commit, best case, and pipeline reliability.", icon: LineChart },
    ],
  },
  {
    category: "Operations",
    description: "Workflow health, due dates, handoffs, and closeout readiness.",
    reports: [
      { name: "Workflow Bottlenecks", description: "Aging by stage and blocked handoff counts.", icon: CalendarClock },
      { name: "Project Readiness", description: "Scoping, estimate, and kickoff completeness.", icon: ClipboardList },
      { name: "Portfolio Load", description: "Active work grouped by company and property.", icon: BriefcaseBusiness },
    ],
  },
  {
    category: "Analytics",
    description: "Higher-level trends and business intelligence surfaces.",
    reports: [
      { name: "Market Mix", description: "Work by vertical, property type, and region.", icon: PieChart },
      { name: "Customer Concentration", description: "Revenue and opportunity exposure by account.", icon: Users },
      { name: "Executive Trends", description: "Multi-period summary of operating indicators.", icon: BarChart3 },
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
                const body = (
                  <CardContent className="flex items-start gap-4 p-5">
                    <div className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-slate-950 text-white">
                      <Icon className="h-5 w-5" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-black uppercase tracking-tight text-slate-950">{report.name}</h3>
                        {report.href ? (
                          <span className="rounded-full bg-emerald-50 px-2 py-1 text-[10px] font-black uppercase tracking-[0.14em] text-emerald-700">
                            Live
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
                return (
                  <Card key={report.name} className={report.href ? "border-slate-200 bg-white transition hover:border-brand-red/40 hover:shadow-sm" : "border-slate-200 bg-white opacity-75"}>
                    {report.href ? (
                      <Link to={report.href} className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-red">
                        {body}
                      </Link>
                    ) : body}
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
