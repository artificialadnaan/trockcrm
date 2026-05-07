import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowUpRight,
  ChevronRight,
  Bell,
  BarChart3,
  User as UserIcon,
  AlertTriangle,
  Activity,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const EYEBROW = "text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500";

const USD = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);

const USD_COMPACT = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(
    value
  );

function formatRelative(seconds: number): string {
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hr ago`;
}

const PERIODS = ["Today", "Week", "MTD", "QTD", "YTD"] as const;
type Period = (typeof PERIODS)[number];

const fixture = {
  firstName: "Brett",
  pipelineValue: 2_840_000,
  activeDealsCount: 12,
  activeLeadsCount: 27,
  qualifiedLeadsCount: 11,
  commissionYtd: 38_400,
  commissionDirect: 31_200,
  overdue: 3,
  cleanupCount: 5,
  ownershipGaps: 2,
  staleLeads: 4,
  followUpRate: 76,
  topDeals: [
    {
      id: "1",
      name: "Dallas ISD Roof Replacement",
      stage: "Estimating",
      stageVariant: "amber" as const,
      days: 22,
      sla: 14,
      value: 875_000,
      ownerInitials: "BR",
    },
    {
      id: "2",
      name: "Frisco Distribution Center",
      stage: "Bid Submitted",
      stageVariant: "blue" as const,
      days: 4,
      sla: 21,
      value: 1_120_000,
      ownerInitials: "BR",
    },
    {
      id: "3",
      name: "Plano Office Tower Re-Cover",
      stage: "Estimating",
      stageVariant: "amber" as const,
      days: 9,
      sla: 14,
      value: 320_000,
      ownerInitials: "BR",
    },
    {
      id: "4",
      name: "Arlington Civic Center",
      stage: "Awarded",
      stageVariant: "green" as const,
      days: 16,
      sla: 14,
      value: 540_000,
      ownerInitials: "BR",
    },
    {
      id: "5",
      name: "Westlake Industrial Park",
      stage: "Qualified",
      stageVariant: "blue" as const,
      days: 6,
      sla: 21,
      value: 410_000,
      ownerInitials: "BR",
    },
  ],
  alerts: [
    {
      severity: "critical" as const,
      title: "3 overdue tasks",
      detail: "Dallas ISD, Plano Tower, Frisco DC",
    },
    {
      severity: "warning" as const,
      title: "Follow-up compliance below 80%",
      detail: "19 of 25 on-time this week",
    },
  ],
  blindSpots: [
    {
      id: "bs1",
      name: "Dallas ISD Roof Replacement",
      ref: "dfw-9-12626-aa",
      issue: "Estimating gate requirements appear incomplete",
      hint: "Close the missing estimating inputs",
      tag: "critical",
      flagged: "5/6/2026",
    },
    {
      id: "bs2",
      name: "Plano Office Tower",
      ref: "dfw-7-44512-bb",
      issue: "Decision maker contact missing",
      hint: "Add primary stakeholder + email",
      tag: "needs review",
      flagged: "5/4/2026",
    },
  ],
  funnel: [
    { label: "Leads", count: 27, sub: "27 active" },
    { label: "Qualified", count: 11, sub: "11 active" },
    { label: "Opportunities", count: 8, sub: USD_COMPACT(1_220_000) },
    { label: "Bid Board", count: 6, sub: USD_COMPACT(1_620_000) },
  ],
  activity: { calls: 24, emails: 41, meetings: 6, notes: 12 },
};

function StagePill({ variant, children }: { variant: "amber" | "blue" | "green" | "red"; children: string }) {
  const styles = {
    amber: "bg-amber-50 text-amber-700 ring-1 ring-amber-200",
    blue: "bg-blue-50 text-blue-700 ring-1 ring-blue-200",
    green: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
    red: "bg-brand-red/10 text-brand-red ring-1 ring-brand-red/20",
  } as const;
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ${styles[variant]}`}>
      {children}
    </span>
  );
}

function PeriodPills({ value, onChange }: { value: Period; onChange: (next: Period) => void }) {
  return (
    <div className="flex items-center gap-1 rounded-full bg-slate-100 p-1">
      {PERIODS.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onChange(p)}
          className={`rounded-full px-3.5 py-1.5 text-xs font-bold transition-colors ${
            value === p ? "bg-brand-red text-white shadow-sm" : "text-slate-600 hover:text-slate-900"
          }`}
        >
          {p}
        </button>
      ))}
    </div>
  );
}

function MetricCard({
  eyebrow,
  value,
  badge,
  badgeTone = "green",
  caption,
  drenched = false,
  accent = "red",
}: {
  eyebrow: string;
  value: string;
  badge: string;
  badgeTone?: "green" | "blue" | "white";
  caption: string;
  drenched?: boolean;
  accent?: "red" | "blue" | "green";
}) {
  const accentColor = accent === "blue" ? "bg-blue-400" : accent === "green" ? "bg-emerald-400" : "bg-brand-red";
  if (drenched) {
    return (
      <Card className="relative overflow-hidden border-0 bg-brand-red text-white shadow-md">
        <CardContent className="p-6">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-white/80">{eyebrow}</p>
              <p className="mt-3 text-5xl font-black leading-none tracking-tight">{value}</p>
              <div className="mt-4 flex items-center gap-3">
                <span className="rounded-full bg-white/15 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ring-1 ring-white/20">
                  {badge}
                </span>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-white/70">{caption}</p>
              </div>
            </div>
            <BarChart3 className="h-12 w-12 text-white/20" />
          </div>
        </CardContent>
      </Card>
    );
  }
  const badgeStyles = {
    green: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
    blue: "bg-blue-50 text-blue-700 ring-1 ring-blue-200",
    white: "bg-white text-slate-700 ring-1 ring-slate-200",
  } as const;
  return (
    <Card className="relative overflow-hidden">
      <CardContent className="p-6">
        <div className="flex items-start justify-between">
          <div>
            <p className={EYEBROW}>{eyebrow}</p>
            <p className="mt-3 text-5xl font-black leading-none tracking-tight text-slate-950">{value}</p>
            <div className="mt-4 flex items-center gap-3">
              <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ${badgeStyles[badgeTone]}`}>
                {badge}
              </span>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{caption}</p>
            </div>
          </div>
        </div>
      </CardContent>
      <div className={`absolute inset-x-0 bottom-0 h-1 ${accentColor}`} aria-hidden />
    </Card>
  );
}

function TopDealsTable({ deals, onOpen }: { deals: typeof fixture.topDeals; onOpen: (id: string) => void }) {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between border-b border-slate-100 pb-3">
        <CardTitle className="text-sm font-bold uppercase tracking-[0.16em] text-slate-950">Top deals</CardTitle>
        <button
          type="button"
          className="flex items-center gap-1 text-sm font-bold text-brand-red transition-colors hover:text-brand-red/80"
        >
          Full report
          <ChevronRight className="h-4 w-4" />
        </button>
      </CardHeader>
      <div className="grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-4 border-b border-slate-100 px-6 py-3 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
        <div>Deal</div>
        <div className="text-right">Stage</div>
        <div className="text-right">Days</div>
        <div className="text-right">Value</div>
        <div className="w-6" aria-hidden />
      </div>
      <div className="divide-y divide-slate-100">
        {deals.map((deal) => (
          <button
            key={deal.id}
            type="button"
            onClick={() => onOpen(deal.id)}
            className="grid w-full grid-cols-[1fr_auto_auto_auto_auto] items-center gap-4 px-6 py-4 text-left transition-colors hover:bg-slate-50"
          >
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-red text-xs font-black uppercase text-white">
                {deal.ownerInitials}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-slate-950">{deal.name}</p>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">SLA {deal.sla}d</p>
              </div>
            </div>
            <div className="flex justify-end">
              <StagePill variant={deal.stageVariant}>{deal.stage}</StagePill>
            </div>
            <p className={`text-right text-sm font-black tabular-nums ${deal.days > deal.sla ? "text-brand-red" : "text-slate-950"}`}>
              {deal.days}d
            </p>
            <p className="text-right text-sm font-black tabular-nums text-slate-950">{USD(deal.value)}</p>
            <ChevronRight className="h-4 w-4 text-slate-400" />
          </button>
        ))}
      </div>
    </Card>
  );
}

function StrategicAlerts({ alerts }: { alerts: typeof fixture.alerts }) {
  return (
    <Card className="relative overflow-hidden border-0 bg-[#0F172A] text-white">
      <CardContent className="p-5">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-400" />
          <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-white">Strategic alerts</p>
          <Activity className="ml-auto h-12 w-20 text-white/10" strokeWidth={1.25} />
        </div>
        <div className="mt-4 space-y-3">
          {alerts.map((alert) => {
            const tone = alert.severity === "critical" ? "bg-brand-red" : "bg-amber-400";
            return (
              <div key={alert.title} className="flex gap-3 rounded-md bg-white/5 p-3">
                <span className={`block w-1 shrink-0 rounded-full ${tone}`} aria-hidden />
                <div className="min-w-0">
                  <p className="text-sm font-bold text-white">{alert.title}</p>
                  <p className="mt-0.5 truncate text-xs text-slate-400">{alert.detail}</p>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function AiBlindSpots({ items }: { items: typeof fixture.blindSpots }) {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between border-b border-slate-100 pb-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          <CardTitle className="text-sm font-bold uppercase tracking-[0.16em] text-slate-950">AI blind spots</CardTitle>
        </div>
        <Badge variant="outline" className="font-black tabular-nums">
          {items.length * 12 + 1}
        </Badge>
      </CardHeader>
      <div className="divide-y divide-slate-100">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className="flex w-full items-start justify-between gap-3 px-5 py-4 text-left transition-colors hover:bg-slate-50"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="truncate text-sm font-bold text-slate-950">{item.name}</p>
                <span className="font-mono text-[10px] text-slate-400">{item.ref}</span>
              </div>
              <p className="mt-1 text-sm font-semibold text-slate-700">{item.issue}</p>
              <p className="mt-1 text-xs text-slate-500">{item.hint}</p>
              <div className="mt-2 flex items-center gap-2">
                <span className="rounded-sm bg-brand-red/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand-red">
                  {item.tag}
                </span>
                <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  Flagged {item.flagged}
                </span>
              </div>
            </div>
            <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-slate-400" />
          </button>
        ))}
      </div>
    </Card>
  );
}

function FunnelStrip({ buckets }: { buckets: typeof fixture.funnel }) {
  return (
    <Card>
      <CardContent className="p-0">
        <div className="grid grid-cols-2 divide-x divide-slate-100 border-b border-slate-100 lg:grid-cols-4">
          {buckets.map((b, i) => (
            <button
              key={b.label}
              type="button"
              className="group flex flex-col items-start gap-1 px-6 py-5 text-left transition-colors hover:bg-slate-50"
            >
              <p className={EYEBROW}>{b.label}</p>
              <p className="text-4xl font-black leading-none tracking-tight text-slate-950">{b.count}</p>
              <p className="text-xs font-semibold text-slate-500">{b.sub}</p>
              {i === buckets.length - 1 ? null : <ChevronRight className="absolute -mr-3 hidden h-4 w-4 self-center text-slate-300" />}
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function KpiCell({
  label,
  value,
  subtitle,
  emphasis = "neutral",
  onClick,
}: {
  label: string;
  value: string | number;
  subtitle?: string;
  emphasis?: "neutral" | "danger" | "warning";
  onClick?: () => void;
}) {
  const valueClass =
    emphasis === "danger"
      ? "text-brand-red"
      : emphasis === "warning"
        ? "text-amber-700"
        : "text-slate-950";
  const baseClass = "flex flex-col items-start gap-1 text-left";
  const body = (
    <>
      <p className={EYEBROW}>{label}</p>
      <p className={`text-3xl font-black leading-none tracking-tight ${valueClass}`}>{value}</p>
      {subtitle ? <p className="text-xs text-muted-foreground">{subtitle}</p> : null}
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`${baseClass} cursor-pointer transition-opacity hover:opacity-70`}
      >
        {body}
      </button>
    );
  }
  return <div className={baseClass}>{body}</div>;
}

export function RepDashboardPreview() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState<Period>("YTD");
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setSeconds((s) => s + 30), 30_000);
    return () => window.clearInterval(id);
  }, []);
  const freshness = formatRelative(seconds);

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-4xl font-black uppercase tracking-tight text-slate-950 md:text-5xl">
            Welcome, {fixture.firstName}
          </h1>
          <p className="mt-2 text-[11px] font-bold uppercase tracking-[0.24em] text-slate-500">
            Today&apos;s work · synced {freshness}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <PeriodPills value={period} onChange={setPeriod} />
          <button
            type="button"
            className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
          >
            <BarChart3 className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="relative flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
          >
            <Bell className="h-4 w-4" />
            <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-brand-red" />
          </button>
          <button
            type="button"
            className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-red text-white"
          >
            <UserIcon className="h-4 w-4" />
          </button>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <MetricCard
          eyebrow="Active deals"
          value={USD_COMPACT(fixture.pipelineValue)}
          badge={`${fixture.activeDealsCount} deals`}
          badgeTone="green"
          caption="Open pipeline"
          accent="red"
        />
        <MetricCard
          eyebrow="Active leads"
          value={String(fixture.activeLeadsCount)}
          badge={`${fixture.qualifiedLeadsCount} qualified`}
          badgeTone="blue"
          caption="Top of funnel"
          accent="blue"
        />
        <MetricCard
          eyebrow={`Commission ${period}`}
          value={USD_COMPACT(fixture.commissionYtd)}
          badge={`${USD_COMPACT(fixture.commissionDirect)} direct`}
          drenched
          caption="Your earnings"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(280px,1fr)]">
        <TopDealsTable deals={fixture.topDeals} onOpen={(id) => navigate(`/deals/${id}`)} />
        <div className="space-y-4">
          <StrategicAlerts alerts={fixture.alerts} />
          <AiBlindSpots items={fixture.blindSpots} />
        </div>
      </div>

      <FunnelStrip buckets={fixture.funnel} />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between border-b border-slate-100 pb-3">
          <CardTitle className="text-sm font-bold uppercase tracking-[0.16em] text-slate-950">My numbers</CardTitle>
          <select className="h-8 rounded-md border bg-white px-2 text-xs font-semibold text-slate-700">
            <option>This week</option>
            <option>This month</option>
          </select>
        </CardHeader>
        <CardContent className="space-y-5 pt-5">
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
            <KpiCell
              label="Cleanup"
              value={fixture.cleanupCount}
              subtitle={`${fixture.ownershipGaps} ownership gaps`}
              emphasis="warning"
              onClick={() => navigate("/pipeline/my-cleanup")}
            />
            <KpiCell
              label="Stale leads"
              value={fixture.staleLeads}
              subtitle="14+ days"
              emphasis="warning"
              onClick={() => navigate("/leads?stale=true")}
            />
            <KpiCell
              label="Follow-up"
              value={`${fixture.followUpRate}%`}
              subtitle="19 of 25 on time"
              emphasis={fixture.followUpRate < 80 ? "warning" : "neutral"}
            />
            <KpiCell
              label="Overdue"
              value={fixture.overdue}
              subtitle="tasks"
              emphasis="danger"
              onClick={() => navigate("/tasks?filter=overdue")}
            />
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-slate-100 pt-5 sm:grid-cols-4">
            <KpiCell label="Calls" value={fixture.activity.calls} />
            <KpiCell label="Emails" value={fixture.activity.emails} />
            <KpiCell label="Meetings" value={fixture.activity.meetings} />
            <KpiCell label="Notes" value={fixture.activity.notes} />
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
        <Button variant="outline" size="lg" onClick={() => navigate("/reports?owner=me")}>
          Performance report
          <ArrowUpRight className="ml-1.5 h-4 w-4" />
        </Button>
        <Button size="lg" onClick={() => navigate("/pipeline")}>
          Open my pipeline
          <ArrowUpRight className="ml-1.5 h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
