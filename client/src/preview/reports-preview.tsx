import { useMemo, useState } from "react";
import {
  Plus,
  Search,
  ChevronDown,
  ChevronRight,
  Play,
  Star,
  Clock,
  Calendar,
  Repeat,
  MoreHorizontal,
  Sparkles,
  TrendingUp,
  Briefcase,
  BarChart3,
  Target,
  PieChart,
  LineChart,
  Users,
  AlertTriangle,
  ClipboardCheck,
  DollarSign,
  Activity,
  Layers,
  ArrowDownToLine,
  Mail,
  CalendarClock,
  CheckCircle2,
  Inbox,
  Library,
  Pencil,
  History,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EYEBROW, MetricCard, ScopeToggle } from "./preview-shared";

type Category = "Sales" | "Performance" | "Operations" | "Analytics";
type ReportKind = "table" | "chart" | "summary";
type Frequency = "Weekly" | "Monthly" | "Quarterly" | "On demand" | "Daily";

type Report = {
  id: string;
  title: string;
  description: string;
  category: Category;
  kind: ReportKind;
  icon: typeof Briefcase;
  lastRun: string;
  runCount: number;
  starred?: boolean;
  scheduled?: { frequency: Frequency; nextRun: string; recipients: number };
  runtimeSeconds?: number;
};

const reports: Report[] = [
  // SALES
  { id: "r1", title: "Pipeline Snapshot", description: "Active deals by stage with value totals and forecast.", category: "Sales", kind: "summary", icon: Briefcase, lastRun: "today, 8:00 AM", runCount: 184, starred: true, scheduled: { frequency: "Daily", nextRun: "tomorrow 8 AM", recipients: 4 }, runtimeSeconds: 4 },
  { id: "r2", title: "Deal Aging", description: "Deals exceeding stage SLA, ranked by days stuck.", category: "Sales", kind: "table", icon: Clock, lastRun: "yesterday", runCount: 92, starred: true, runtimeSeconds: 3 },
  { id: "r3", title: "Win/Loss Analysis", description: "Closed-won and closed-lost deals with reasons and competitor data.", category: "Sales", kind: "chart", icon: PieChart, lastRun: "3 days ago", runCount: 47 },
  { id: "r4", title: "Conversion Funnel", description: "Lead → Qualified → Opportunity → Won conversion rates by stage.", category: "Sales", kind: "chart", icon: TrendingUp, lastRun: "1 week ago", runCount: 31 },
  { id: "r5", title: "Bid Board Activity", description: "All deals synced from Procore Bid Board with status and owner.", category: "Sales", kind: "table", icon: Layers, lastRun: "today, 6:00 AM", runCount: 156, scheduled: { frequency: "Daily", nextRun: "tomorrow 6 AM", recipients: 2 } },

  // PERFORMANCE
  { id: "r6", title: "Team Lead Weekly Report", description: "Rep performance summary for directors. Calls, emails, deals moved, win rate.", category: "Performance", kind: "summary", icon: Users, lastRun: "Mon 7:00 AM", runCount: 28, starred: true, scheduled: { frequency: "Weekly", nextRun: "Mon 7 AM", recipients: 6 } },
  { id: "r7", title: "Rep Commission Statement", description: "Per-rep commission breakdown with overrides and rolling floor.", category: "Performance", kind: "summary", icon: DollarSign, lastRun: "May 1, 8:00 AM", runCount: 12, scheduled: { frequency: "Monthly", nextRun: "Jun 1 8 AM", recipients: 8 } },
  { id: "r8", title: "Activity Goals", description: "Calls, emails, meetings, and notes vs. weekly target by rep.", category: "Performance", kind: "chart", icon: Target, lastRun: "Mon 7:00 AM", runCount: 78, scheduled: { frequency: "Weekly", nextRun: "Mon 7 AM", recipients: 4 } },
  { id: "r9", title: "Follow-up Compliance", description: "On-time vs. late follow-ups by rep with offending records.", category: "Performance", kind: "table", icon: ClipboardCheck, lastRun: "yesterday", runCount: 64 },

  // OPERATIONS
  { id: "r10", title: "Pipeline Cleanup Queue", description: "Records flagged for missing fields, ownership gaps, or stale data.", category: "Operations", kind: "table", icon: AlertTriangle, lastRun: "today, 5:00 AM", runCount: 211, scheduled: { frequency: "Daily", nextRun: "tomorrow 5 AM", recipients: 3 } },
  { id: "r11", title: "Stale Records Audit", description: "Deals, leads, and contacts past their staleness threshold.", category: "Operations", kind: "table", icon: Activity, lastRun: "today, 5:00 AM", runCount: 198, scheduled: { frequency: "Daily", nextRun: "tomorrow 5 AM", recipients: 3 } },
  { id: "r12", title: "Procore Sync Health", description: "Sync errors, retry counts, and orphan records by tenant.", category: "Operations", kind: "summary", icon: Repeat, lastRun: "today, 9:00 AM", runCount: 245 },
  { id: "r13", title: "Email Parking Lot", description: "Unassigned emails awaiting manual review.", category: "Operations", kind: "table", icon: Inbox, lastRun: "today, 7:30 AM", runCount: 88 },

  // ANALYTICS
  { id: "r14", title: "Forecast vs Actual", description: "Monthly forecast accuracy with rolling 12-month trend.", category: "Analytics", kind: "chart", icon: LineChart, lastRun: "May 1", runCount: 24, scheduled: { frequency: "Monthly", nextRun: "Jun 1", recipients: 5 } },
  { id: "r15", title: "Win Rate by Region", description: "DFW market segmentation showing close rates and average deal size.", category: "Analytics", kind: "chart", icon: BarChart3, lastRun: "1 week ago", runCount: 19 },
  { id: "r16", title: "Average Deal Cycle Time", description: "Days from Opportunity to Won, broken down by stage.", category: "Analytics", kind: "chart", icon: Clock, lastRun: "2 weeks ago", runCount: 15 },
];

const categoryStyles: Record<Category, { tone: string; iconTone: string; accent: "red" | "blue" | "green" }> = {
  Sales: { tone: "bg-brand-red/10 text-brand-red ring-brand-red/20", iconTone: "bg-brand-red/10 text-brand-red", accent: "red" },
  Performance: { tone: "bg-blue-50 text-blue-700 ring-blue-200", iconTone: "bg-blue-50 text-blue-700", accent: "blue" },
  Operations: { tone: "bg-amber-50 text-amber-700 ring-amber-200", iconTone: "bg-amber-50 text-amber-700", accent: "red" },
  Analytics: { tone: "bg-violet-50 text-violet-700 ring-violet-200", iconTone: "bg-violet-50 text-violet-700", accent: "blue" },
};

const kindLabel: Record<ReportKind, string> = {
  table: "Table",
  chart: "Chart",
  summary: "Summary",
};

type View = "library" | "mine" | "scheduled" | "recent";

function ReportCard({ r, onRun, onStar }: { r: Report; onRun: (r: Report) => void; onStar: (id: string) => void }) {
  const Icon = r.icon;
  const cat = categoryStyles[r.category];
  return (
    <div className="group flex h-full flex-col rounded-md border border-slate-200 bg-white p-4 transition-colors hover:border-slate-300">
      <div className="flex items-start gap-3">
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md ${cat.iconTone}`}>
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-sm font-black text-slate-950">{r.title}</p>
            <button
              type="button"
              onClick={() => onStar(r.id)}
              className="shrink-0 text-slate-300 hover:text-amber-500"
              aria-label={r.starred ? "Unpin" : "Pin"}
            >
              <Star className={`h-3.5 w-3.5 ${r.starred ? "fill-amber-400 stroke-amber-500" : ""}`} />
            </button>
          </div>
          <span className={`mt-1 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${cat.tone}`}>
            {r.category} · {kindLabel[r.kind]}
          </span>
        </div>
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 opacity-0 transition-opacity hover:bg-slate-100 hover:text-slate-900 group-hover:opacity-100"
          aria-label="More"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </div>

      <p className="mt-3 line-clamp-2 text-xs text-slate-600">{r.description}</p>

      <div className="mt-auto flex flex-wrap items-center gap-2 pt-3">
        <p className="flex items-center gap-1 text-[10px] font-semibold text-slate-500">
          <History className="h-3 w-3" />
          {r.lastRun}
        </p>
        {r.scheduled ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700 ring-1 ring-emerald-200">
            <Repeat className="h-2.5 w-2.5" />
            {r.scheduled.frequency}
          </span>
        ) : null}
      </div>

      <div className="mt-3 flex items-center gap-2 border-t border-slate-100 pt-3">
        <Button size="sm" onClick={() => onRun(r)} className="flex-1">
          <Play className="mr-1 h-3.5 w-3.5 fill-current" />
          Run
        </Button>
        <button
          type="button"
          className="flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
          aria-label="Schedule"
        >
          <Calendar className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className="flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
          aria-label="Export"
        >
          <ArrowDownToLine className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function BuilderCard({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex h-full flex-col items-start justify-between rounded-md border-2 border-dashed border-brand-red/30 bg-brand-red/5 p-4 text-left transition-colors hover:border-brand-red/60 hover:bg-brand-red/10"
    >
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-brand-red text-white">
          <Sparkles className="h-5 w-5" />
        </span>
        <div>
          <p className="text-sm font-black text-slate-950">Build custom report</p>
          <span className="mt-1 inline-flex items-center rounded-full bg-brand-red/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand-red ring-1 ring-brand-red/20">
            Drag & drop builder
          </span>
        </div>
      </div>
      <p className="mt-3 text-xs text-slate-600">
        Pick a data source, choose metrics and filters, then save it to your library or schedule it.
      </p>
      <div className="mt-3 flex items-center gap-1 text-xs font-bold text-brand-red">
        Open builder
        <ChevronRight className="h-3.5 w-3.5" />
      </div>
    </button>
  );
}

export function ReportsPreview() {
  const [scope, setScope] = useState<"Mine" | "Team" | "All">("All");
  const [view, setView] = useState<View>("library");
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<Category | "All">("All");
  const [reportState, setReportState] = useState<Report[]>(reports);

  const handleStar = (id: string) =>
    setReportState((current) => current.map((r) => (r.id === id ? { ...r, starred: !r.starred } : r)));

  const handleRun = (_r: Report) => {
    // preview-only, no-op
  };

  const filtered = useMemo(() => {
    return reportState.filter((r) => {
      if (activeCategory !== "All" && r.category !== activeCategory) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        if (!r.title.toLowerCase().includes(q) && !r.description.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [reportState, activeCategory, search]);

  const pinned = filtered.filter((r) => r.starred);
  const grouped: Record<Category, Report[]> = {
    Sales: filtered.filter((r) => r.category === "Sales"),
    Performance: filtered.filter((r) => r.category === "Performance"),
    Operations: filtered.filter((r) => r.category === "Operations"),
    Analytics: filtered.filter((r) => r.category === "Analytics"),
  };

  const totals = {
    all: reportState.length,
    pinned: reportState.filter((r) => r.starred).length,
    scheduled: reportState.filter((r) => r.scheduled).length,
    runsThisMonth: reportState.reduce((s, r) => s + (r.runCount % 50), 0),
  };

  const scheduledList = reportState.filter((r) => r.scheduled);
  const recentList = [...reportState].sort((a, b) => b.runCount - a.runCount).slice(0, 8);

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-4xl font-black uppercase tracking-tight text-slate-950 md:text-5xl">Reports</h1>
          <p className="mt-2 text-[11px] font-bold uppercase tracking-[0.24em] text-slate-500">
            {totals.all} reports · {totals.scheduled} scheduled · {totals.runsThisMonth} runs this month
          </p>
        </div>
        <div className="flex items-center gap-3">
          <ScopeToggle options={["Mine", "Team", "All"] as const} value={scope} onChange={setScope} />
          <Button size="lg">
            <Plus className="mr-1.5 h-4 w-4" />
            New report
          </Button>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <MetricCard
          eyebrow="Pinned"
          value={String(totals.pinned)}
          badge="quick access"
          badgeTone="green"
          caption="In your library"
          accent="red"
        />
        <MetricCard
          eyebrow="Scheduled"
          value={String(totals.scheduled)}
          badge={`${scheduledList.filter((r) => r.scheduled?.frequency === "Daily").length} daily`}
          badgeTone="blue"
          caption="Auto-emailed"
          accent="blue"
        />
        <MetricCard
          eyebrow="Runs this month"
          value={String(totals.runsThisMonth)}
          badge="across all reports"
          drenched
          caption="Most-run: Pipeline Snapshot"
        />
      </div>

      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-slate-100 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-1 rounded-md border border-slate-200 bg-white p-0.5">
            {(
              [
                { key: "library", label: "Library", icon: Library, count: reportState.length },
                { key: "mine", label: "My reports", icon: Pencil, count: 3 },
                { key: "scheduled", label: "Scheduled", icon: CalendarClock, count: scheduledList.length },
                { key: "recent", label: "Recent", icon: History, count: recentList.length },
              ] as const
            ).map((v) => {
              const Icon = v.icon;
              const isActive = view === v.key;
              return (
                <button
                  key={v.key}
                  type="button"
                  onClick={() => setView(v.key)}
                  className={`flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-xs font-bold transition-colors ${
                    isActive ? "bg-slate-100 text-slate-950" : "text-slate-500 hover:text-slate-900"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {v.label}
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[10px] font-black tabular-nums ${
                      isActive ? "bg-brand-red/10 text-brand-red" : "bg-slate-100 text-slate-600"
                    }`}
                  >
                    {v.count}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 rounded-md bg-slate-100 px-3 py-2 lg:max-w-sm">
              <Search className="h-4 w-4 text-slate-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search reports"
                className="flex-1 bg-transparent text-sm placeholder:text-slate-500 focus:outline-none"
              />
            </div>
          </div>
        </div>

        {view === "library" ? (
          <div className="space-y-6 p-5">
            <div className="flex flex-wrap items-center gap-2">
              <p className={`${EYEBROW} self-center`}>Category:</p>
              {(["All", "Sales", "Performance", "Operations", "Analytics"] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setActiveCategory(c)}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide transition-colors ${
                    activeCategory === c ? "bg-brand-red text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>

            {pinned.length > 0 ? (
              <section>
                <div className="mb-3 flex items-center gap-2">
                  <Star className="h-3.5 w-3.5 fill-amber-400 stroke-amber-500" />
                  <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500">
                    Pinned · {pinned.length}
                  </p>
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                  <BuilderCard onClick={() => undefined} />
                  {pinned.map((r) => (
                    <ReportCard key={r.id} r={r} onRun={handleRun} onStar={handleStar} />
                  ))}
                </div>
              </section>
            ) : null}

            {(["Sales", "Performance", "Operations", "Analytics"] as Category[]).map((cat) => {
              const items = grouped[cat].filter((r) => !r.starred || pinned.length === 0);
              if (items.length === 0) return null;
              return (
                <section key={cat}>
                  <div className="mb-3 flex items-center gap-2">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${categoryStyles[cat].tone}`}
                    >
                      {cat}
                    </span>
                    <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500">{items.length} reports</p>
                  </div>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {items.map((r) => (
                      <ReportCard key={r.id} r={r} onRun={handleRun} onStar={handleStar} />
                    ))}
                  </div>
                </section>
              );
            })}

            {filtered.length === 0 ? (
              <div className="px-5 py-12 text-center">
                <Library className="mx-auto h-8 w-8 text-slate-300" />
                <p className="mt-2 text-sm font-semibold text-slate-700">No reports match these filters.</p>
              </div>
            ) : null}
          </div>
        ) : null}

        {view === "mine" ? (
          <div className="px-5 py-12 text-center">
            <Pencil className="mx-auto h-8 w-8 text-slate-300" />
            <p className="mt-2 text-sm font-semibold text-slate-700">No custom reports yet.</p>
            <p className="mt-1 text-xs text-slate-500">Build one from scratch or duplicate any library report.</p>
            <Button size="sm" className="mt-3">
              <Sparkles className="mr-1 h-4 w-4" />
              Open builder
            </Button>
          </div>
        ) : null}

        {view === "scheduled" ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-100 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
                  <th className="px-5 py-3 text-left">Report</th>
                  <th className="px-5 py-3 text-left">Frequency</th>
                  <th className="px-5 py-3 text-left">Next run</th>
                  <th className="px-5 py-3 text-right">Recipients</th>
                  <th className="px-5 py-3 text-left">Owner</th>
                  <th className="w-10 px-5 py-3" aria-hidden />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {scheduledList.map((r) => {
                  const Icon = r.icon;
                  const cat = categoryStyles[r.category];
                  return (
                    <tr key={r.id} className="cursor-pointer transition-colors hover:bg-slate-50">
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-3">
                          <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${cat.iconTone}`}>
                            <Icon className="h-4 w-4" />
                          </span>
                          <div>
                            <p className="font-bold text-slate-950">{r.title}</p>
                            <p className="mt-0.5 text-xs text-slate-500">{r.category}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-3">
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-emerald-700 ring-1 ring-emerald-200">
                          <Repeat className="h-2.5 w-2.5" />
                          {r.scheduled!.frequency}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-sm font-semibold text-slate-700 tabular-nums">
                        {r.scheduled!.nextRun}
                      </td>
                      <td className="px-5 py-3 text-right">
                        <span className="inline-flex items-center gap-1 text-sm font-bold tabular-nums text-slate-700">
                          <Mail className="h-3 w-3 text-slate-400" />
                          {r.scheduled!.recipients}
                        </span>
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-red text-[10px] font-black uppercase text-white">
                            BR
                          </span>
                          <span className="text-sm text-slate-700">Brett Rios</span>
                        </div>
                      </td>
                      <td className="px-5 py-3 text-right">
                        <button
                          type="button"
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-900"
                          aria-label="More"
                        >
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}

        {view === "recent" ? (
          <div className="divide-y divide-slate-100">
            {recentList.map((r) => {
              const Icon = r.icon;
              const cat = categoryStyles[r.category];
              return (
                <div
                  key={r.id}
                  className="group flex items-center gap-4 px-5 py-3 transition-colors hover:bg-slate-50"
                >
                  <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${cat.iconTone}`}>
                    <Icon className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-bold text-slate-950">{r.title}</p>
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${cat.tone}`}>
                        {r.category}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-slate-500">{r.description}</p>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-slate-500">
                    <span className="flex items-center gap-1 tabular-nums">
                      <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                      {r.runCount} runs
                    </span>
                    <span className="font-semibold text-slate-700">{r.lastRun}</span>
                    <span className="hidden tabular-nums text-slate-400 sm:inline">{r.runtimeSeconds ?? 5}s</span>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => handleRun(r)}>
                    <Play className="mr-1 h-3 w-3 fill-current" />
                    Re-run
                  </Button>
                </div>
              );
            })}
          </div>
        ) : null}
      </Card>
    </div>
  );
}
