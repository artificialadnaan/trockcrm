import { useRepDashboard, type RepDashboardData } from "@/hooks/use-dashboard";
import { useAuth } from "@/lib/auth";
import { Link, useNavigate } from "react-router-dom";
import { useTasks } from "@/hooks/use-tasks";
import { ActivityRangeSelect } from "@/components/dashboard/activity-range-select";
import { type ActivityRange } from "@trock-crm/shared/types";
import { cn } from "@/lib/utils";
import { buttonVariants, Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  BarChart3,
  Bell,
  ChevronRight,
  RefreshCw,
  User as UserIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

const EYEBROW = "text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500";
const PERIODS = ["Today", "Week", "MTD", "QTD", "YTD"] as const;

type Period = (typeof PERIODS)[number];
type StageVariant = "amber" | "blue" | "green" | "red";
type RepDealsFilter = "active_pipeline" | "opportunities" | "bid_board";

interface TopDealRow {
  id: string;
  name: string;
  stage: string;
  stageVariant: StageVariant;
  days: number;
  sla: number | null;
  value: number;
  initials: string;
}

interface StrategicAlert {
  severity: "critical" | "warning";
  title: string;
  detail: string;
}

interface BlindSpot {
  id: string;
  type: "deal" | "lead";
  name: string;
  ref: string;
  issue: string;
  hint: string;
  tag: "critical" | "needs review";
  flagged: string;
}

function formatShortDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "numeric",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function formatRelativeTime(date: Date, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return formatShortDate(date.toISOString());
}

function useFreshness(fetchedAt: Date | null): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  if (!fetchedAt) return "pending";
  return formatRelativeTime(fetchedAt, now);
}

function formatUsd(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatCompactUsd(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function periodToActivityRange(period: Period): ActivityRange {
  if (period === "MTD") return "month";
  if (period === "YTD" || period === "QTD") return "ytd";
  return "week";
}

function periodToDealDrilldownPeriod(period: Period): "today" | "week" | "mtd" | "qtd" | "ytd" {
  if (period === "Today") return "week";
  if (period === "Week") return "week";
  if (period === "QTD") return "qtd";
  if (period === "YTD") return "ytd";
  return "mtd";
}

export function buildRepDealsDrilldownPath(filter: RepDealsFilter, period: Period) {
  return `/deals?filter=${filter}&period=${periodToDealDrilldownPeriod(period)}&scope=mine`;
}

function initials(name: string | null | undefined) {
  const parts = (name ?? "TR").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "TR";
  return parts.slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function stageVariant(stageName: string, days: number, sla: number | null): StageVariant {
  const stage = stageName.toLowerCase();
  if (sla != null && days > sla) return "red";
  if (stage.includes("award") || stage.includes("won") || stage.includes("signed")) return "green";
  if (stage.includes("bid") || stage.includes("qualified")) return "blue";
  return "amber";
}

function bucketCount(data: RepDashboardData, key: string) {
  return data.funnelBuckets.find((bucket) => bucket.key === key || bucket.bucket === key)?.count ?? 0;
}

function bucketValue(data: RepDashboardData, key: string) {
  return data.funnelBuckets.find((bucket) => bucket.key === key || bucket.bucket === key)?.totalValue ?? 0;
}

function buildTopDeals(data: RepDashboardData, repName: string): TopDealRow[] {
  const bottlenecks = (data.downstreamBottlenecks ?? []).map((deal) => ({
    id: deal.dealId,
    name: deal.dealName,
    stage: deal.stageName,
    stageVariant: stageVariant(deal.stageName, deal.daysInStage, deal.staleThresholdDays),
    days: deal.daysInStage,
    sla: deal.staleThresholdDays,
    value: deal.dealValue,
    initials: initials(repName),
  }));
  const seen = new Set(bottlenecks.map((deal) => deal.id));
  const snapshots = data.dealSnapshot
    .filter((deal) => !seen.has(deal.dealId))
    .map((deal) => ({
      id: deal.dealId,
      name: deal.dealName,
      stage: deal.stageName,
      stageVariant: stageVariant(deal.stageName, 0, null),
      days: 0,
      sla: null,
      value: deal.totalValue,
      initials: initials(repName),
    }));
  return [...bottlenecks, ...snapshots].sort((a, b) => b.value - a.value).slice(0, 5);
}

function buildStrategicAlerts(data: RepDashboardData): StrategicAlert[] {
  const alerts: StrategicAlert[] = [];
  if (data.tasksToday.overdue > 0) {
    alerts.push({
      severity: "critical",
      title: `${data.tasksToday.overdue} overdue tasks`,
      detail: "Open the task queue before moving pipeline stages",
    });
  }
  if (data.followUpCompliance.total > 0 && data.followUpCompliance.complianceRate < 80) {
    alerts.push({
      severity: "warning",
      title: "Follow-up compliance below 80%",
      detail: `${data.followUpCompliance.onTime} of ${data.followUpCompliance.total} on time this period`,
    });
  }
  if (data.myCleanup.total > 0) {
    alerts.push({
      severity: "warning",
      title: `${data.myCleanup.total} cleanup records`,
      detail: "Forecast, next step, decision maker, or budget needs attention",
    });
  }
  return alerts.slice(0, 3);
}

function buildBlindSpots(data: RepDashboardData): BlindSpot[] {
  const staleDealItems = (data.downstreamBottlenecks ?? [])
    .map((deal) => ({
      id: deal.dealId,
      type: "deal" as const,
      name: deal.dealName,
      ref: deal.regionClassification,
      issue: "Service stage is past SLA",
      hint: `${deal.daysInStage} days in ${deal.stageName}; SLA ${deal.staleThresholdDays} days`,
      tag: "critical" as const,
      flagged: "today",
    }));
  const staleLeadItems = data.staleLeads.leads.map((lead) => ({
    id: lead.leadId,
    type: "lead" as const,
    name: lead.leadName,
    ref: lead.locationLabel ?? lead.stageName,
    issue: "Lead has gone stale",
    hint: `${lead.daysInStage} days in ${lead.stageName}`,
    tag: "needs review" as const,
    flagged: "today",
  }));
  return [...staleDealItems, ...staleLeadItems].slice(0, 3);
}

function StagePill({ variant, children }: { variant: StageVariant; children: string }) {
  const styles = {
    amber: "bg-amber-50 text-amber-700 ring-1 ring-amber-200",
    blue: "bg-blue-50 text-blue-700 ring-1 ring-blue-200",
    green: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
    red: "bg-brand-red/10 text-brand-red ring-1 ring-brand-red/20",
  } as const;
  return (
    <span className={cn("inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide", styles[variant])}>
      {children}
    </span>
  );
}

function TimeRangeTabs({ value, onChange }: { value: Period; onChange: (next: Period) => void }) {
  return (
    <div className="flex items-center gap-1 rounded-full bg-slate-100 p-1">
      {PERIODS.map((period) => (
        <button
          key={period}
          type="button"
          aria-pressed={value === period}
          onClick={() => onChange(period)}
          className={cn(
            "rounded-full px-3.5 py-1.5 text-xs font-bold transition-colors",
            value === period ? "bg-brand-red text-white shadow-sm" : "text-slate-600 hover:text-slate-900"
          )}
        >
          {period}
        </button>
      ))}
    </div>
  );
}

function KpiCard({
  eyebrow,
  value,
  badge,
  caption,
  accent = "red",
  drenched = false,
  to,
  ariaLabel,
}: {
  eyebrow: string;
  value: string;
  badge: string;
  caption: string;
  accent?: "red" | "blue" | "green";
  drenched?: boolean;
  to?: string;
  ariaLabel?: string;
}) {
  const accentColor = accent === "blue" ? "bg-blue-400" : accent === "green" ? "bg-emerald-400" : "bg-brand-red";
  const interactiveClass =
    "block cursor-pointer transition-all hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-red";
  if (drenched) {
    const card = (
      <Card className="relative overflow-hidden border-0 bg-brand-red text-white shadow-md">
        <CardContent className="p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-white/80">{eyebrow.toUpperCase()}</p>
              <p className="mt-3 text-5xl font-black leading-none tracking-tight">{value}</p>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <span className="rounded-full bg-white/15 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ring-1 ring-white/20">
                  {badge.toUpperCase()}
                </span>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-white/70">{caption.toUpperCase()}</p>
              </div>
            </div>
            <BarChart3 className="h-12 w-12 text-white/20" />
          </div>
        </CardContent>
      </Card>
    );
    return to ? (
      <Link to={to} aria-label={ariaLabel} className={interactiveClass}>
        {card}
      </Link>
    ) : card;
  }
  const card = (
    <Card className="relative overflow-hidden">
      <CardContent className="p-6">
      <p className={EYEBROW}>{eyebrow.toUpperCase()}</p>
        <p className="mt-3 text-5xl font-black leading-none tracking-tight text-slate-950">{value}</p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-emerald-700 ring-1 ring-emerald-200">
            {badge.toUpperCase()}
          </span>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{caption.toUpperCase()}</p>
        </div>
      </CardContent>
      <div className={cn("absolute inset-x-0 bottom-0 h-1", accentColor)} aria-hidden />
    </Card>
  );
  return to ? (
    <Link to={to} aria-label={ariaLabel} className={interactiveClass}>
      {card}
    </Link>
  ) : card;
}

function TopDealsTable({ deals, onOpen }: { deals: TopDealRow[]; onOpen: (id: string) => void }) {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between border-b border-slate-100 pb-3">
        <CardTitle className="text-sm font-bold uppercase tracking-[0.16em] text-slate-950">TOP DEALS</CardTitle>
        <Link to="/reports/performance" className="flex items-center gap-1 text-sm font-bold text-brand-red transition-colors hover:text-brand-red/80">
          Full report
          <ChevronRight className="h-4 w-4" />
        </Link>
      </CardHeader>
      <div className="grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-4 border-b border-slate-100 px-6 py-3 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
        <div>Deal</div>
        <div className="text-right">Stage</div>
        <div className="text-right">Days</div>
        <div className="text-right">Value</div>
        <div className="w-6" aria-hidden />
      </div>
      {deals.length === 0 ? (
        <p className="px-6 py-8 text-sm text-slate-500">No active deals.</p>
      ) : (
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
                  {deal.initials}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-slate-950">{deal.name}</p>
                  {deal.sla == null ? null : (
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">SLA {deal.sla}d</p>
                  )}
                </div>
              </div>
              <div className="flex justify-end">
                <StagePill variant={deal.stageVariant}>{deal.stage.toUpperCase()}</StagePill>
              </div>
              <p className={cn("text-right text-sm font-black tabular-nums", deal.sla != null && deal.days > deal.sla ? "text-brand-red" : "text-slate-950")}>
                {deal.days}d
              </p>
              <p className="text-right text-sm font-black tabular-nums text-slate-950">{formatUsd(deal.value)}</p>
              <ChevronRight className="h-4 w-4 text-slate-400" />
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}

function StrategicAlertsPanel({ alerts }: { alerts: StrategicAlert[] }) {
  return (
    <Card className="relative overflow-hidden border-0 bg-[#0F172A] text-white">
      <CardContent className="p-5">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-400" />
          <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-white">STRATEGIC ALERTS</p>
          <Activity className="ml-auto h-12 w-20 text-white/10" strokeWidth={1.25} />
        </div>
        {alerts.length === 0 ? (
          <p className="mt-4 rounded-md bg-white/5 p-3 text-sm text-slate-300">No strategic alerts right now.</p>
        ) : (
          <div className="mt-4 space-y-3">
            {alerts.map((alert) => (
              <div key={alert.title} className="flex gap-3 rounded-md bg-white/5 p-3">
                <span className={cn("block w-1 shrink-0 rounded-full", alert.severity === "critical" ? "bg-brand-red" : "bg-amber-400")} aria-hidden />
                <div className="min-w-0">
                  <p className="text-sm font-bold text-white">{alert.title}</p>
                  <p className="mt-0.5 truncate text-xs text-slate-400">{alert.detail}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AiBlindSpotsPanel({ items }: { items: BlindSpot[] }) {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between border-b border-slate-100 pb-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          <CardTitle className="text-sm font-bold uppercase tracking-[0.16em] text-slate-950">AI BLIND SPOTS</CardTitle>
        </div>
        <Badge variant="outline" className="font-black tabular-nums">
          {items.length}
        </Badge>
      </CardHeader>
      {items.length === 0 ? (
        <p className="px-5 py-6 text-sm text-slate-500">No blind spots from current dashboard data.</p>
      ) : (
        <div className="divide-y divide-slate-100">
          {items.map((item) => (
            <Link
              key={item.id}
              to={item.type === "deal" ? `/deals/${item.id}` : `/leads/${item.id}`}
              className="flex w-full items-start justify-between gap-3 px-5 py-4 text-left transition-colors hover:bg-slate-50"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-bold text-slate-950">{item.name}</p>
                  <span className="font-mono text-[10px] text-slate-400">{item.ref}</span>
                </div>
                <p className="mt-1 text-sm font-semibold text-slate-700">{item.issue}</p>
                <p className="mt-1 text-xs text-slate-500">{item.hint}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="rounded-sm bg-brand-red/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand-red">
                    {item.tag}
                  </span>
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                    Flagged {item.flagged}
                  </span>
                </div>
              </div>
              <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-slate-400" />
            </Link>
          ))}
        </div>
      )}
    </Card>
  );
}

function KpiTile({ label, value, subtext, to }: { label: string; value: string | number; subtext?: string; to: string }) {
  return (
    <Link to={to} className="group flex flex-col items-start gap-1 px-6 py-5 text-left transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-red">
      <p className={EYEBROW}>{label.toUpperCase()}</p>
      <p className="text-4xl font-black leading-none tracking-tight text-slate-950">{value}</p>
      {subtext ? <p className="text-xs font-semibold text-slate-500">{subtext}</p> : null}
    </Link>
  );
}

function MetricCell({
  label,
  value,
  subtitle,
  emphasis = "neutral",
  to,
}: {
  label: string;
  value: string | number;
  subtitle?: string;
  emphasis?: "neutral" | "danger" | "warning";
  to: string;
}) {
  const valueClass =
    emphasis === "danger" ? "text-brand-red" : emphasis === "warning" ? "text-amber-700" : "text-slate-950";
  const body = (
    <>
      <p className={EYEBROW}>{label.toUpperCase()}</p>
      <p className={cn("text-3xl font-black leading-none tracking-tight", valueClass)}>{value}</p>
      {subtitle ? <p className="text-xs text-muted-foreground">{subtitle}</p> : null}
    </>
  );
  return (
    <Link to={to} className="flex flex-col items-start gap-1 text-left transition-opacity hover:opacity-70 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-red">
      {body}
    </Link>
  );
}

export function RepDashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [period, setPeriod] = useState<Period>("YTD");
  const [numbersRange, setNumbersRange] = useState<ActivityRange>("week");
  const dashboardRange = periodToActivityRange(period);
  const { data, loading, error, fetchedAt, refetch } = useRepDashboard({ range: dashboardRange });
  const freshness = useFreshness(fetchedAt);
  const { tasks: overdueTasks, refetch: refetchOverdue } = useTasks({ section: "overdue", limit: 50 });
  const { tasks: todayTasks, refetch: refetchToday } = useTasks({ section: "today", limit: 50 });
  const displayName = user?.displayName ?? "T Rock";
  const firstName = displayName.split(" ")[0]?.toUpperCase() || "THERE";

  const refreshAll = async () => {
    const results = await Promise.allSettled([
      refetch(),
      refetchOverdue(),
      refetchToday(),
    ]);
    results.forEach((result) => {
      if (result.status === "rejected") {
        console.error("Dashboard refresh: section failed", result.reason);
      }
    });
  };

  const derived = useMemo(() => {
    if (!data) return null;
    const topDeals = buildTopDeals(data, displayName);
    const alerts = buildStrategicAlerts({
      ...data,
      tasksToday: {
        overdue: Math.max(data.tasksToday.overdue, overdueTasks.length),
        today: Math.max(data.tasksToday.today, todayTasks.length),
      },
    });
    const blindSpots = buildBlindSpots(data);
    const ownershipGaps = data.myCleanup.byReason
      .filter((reason) => reason.reasonCode.includes("owner"))
      .reduce((sum, reason) => sum + reason.count, 0);
    return { topDeals, alerts, blindSpots, ownershipGaps };
  }, [data, displayName, overdueTasks.length, todayTasks.length]);

  if (loading) {
    return (
      <div className="space-y-6">
        <section className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-4xl font-black uppercase tracking-tight text-slate-950 md:text-5xl">
              WELCOME, {firstName}
            </h1>
            <p className="mt-2 text-[11px] font-bold uppercase tracking-[0.24em] text-slate-500">
              TODAY&apos;S WORK · SYNCING
            </p>
          </div>
          <TimeRangeTabs value={period} onChange={setPeriod} />
        </section>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <Card key={index} className="animate-pulse">
              <CardContent className="h-36 p-6" />
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <section>
          <h1 className="text-4xl font-black uppercase tracking-tight text-slate-950 md:text-5xl">
            WELCOME, {firstName}
          </h1>
          <p className="mt-2 text-[11px] font-bold uppercase tracking-[0.24em] text-slate-500">DASHBOARD UNAVAILABLE</p>
        </section>
        <Card>
          <CardContent className="space-y-3 p-6 text-center">
            <p className="text-sm text-muted-foreground">{error}</p>
            <Button variant="outline" onClick={refreshAll}>
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!data || !derived) return null;

  const qualifiedCount = bucketCount(data, "qualified_lead");
  const opportunityCount = bucketCount(data, "opportunity");
  const opportunityValue = bucketValue(data, "opportunity");
  const bidBoardCount = bucketCount(data, "estimating");
  const bidBoardValue = bucketValue(data, "estimating");
  const staleAge = Math.round(data.staleLeads.averageDaysInStage ?? 14);
  const activeDealsPath = buildRepDealsDrilldownPath("active_pipeline", period);
  const opportunitiesPath = buildRepDealsDrilldownPath("opportunities", period);
  const bidBoardPath = buildRepDealsDrilldownPath("bid_board", period);

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-4xl font-black uppercase tracking-tight text-slate-950 md:text-5xl">
            WELCOME, {firstName}
          </h1>
          <p className="mt-2 text-[11px] font-bold uppercase tracking-[0.24em] text-slate-500">
            TODAY&apos;S WORK · SYNCED {freshness.toUpperCase()}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <TimeRangeTabs value={period} onChange={setPeriod} />
          <button
            type="button"
            aria-label="Open charts"
            className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
          >
            <BarChart3 className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label="Open notifications"
            className="relative flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
          >
            <Bell className="h-4 w-4" />
            {data.tasksToday.overdue > 0 ? <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-brand-red" /> : null}
          </button>
          <button
            type="button"
            aria-label="Refresh dashboard"
            onClick={refreshAll}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label="Open profile"
            className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-red text-white"
          >
            <UserIcon className="h-4 w-4" />
          </button>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <KpiCard
          eyebrow="Active deals"
          value={formatCompactUsd(data.activeDeals.totalValue)}
          badge={`${data.activeDeals.count} deals`}
          caption="Open pipeline"
          accent="red"
          to={activeDealsPath}
          ariaLabel="View active deals"
        />
        <KpiCard
          eyebrow="Active leads"
          value={String(data.activeLeads.count)}
          badge={`${qualifiedCount} qualified`}
          caption="Top of funnel"
          accent="blue"
          to="/leads?scope=mine"
          ariaLabel="View active leads"
        />
        <KpiCard
          eyebrow={`Commission ${period}`}
          value={formatCompactUsd(data.commissionSummary.totalEarnedCommission)}
          badge={`${formatCompactUsd(data.commissionSummary.directEarnedCommission)} direct`}
          caption="Your earnings"
          drenched
          to="/commissions"
          ariaLabel="View commissions"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(280px,1fr)]">
        <TopDealsTable deals={derived.topDeals} onOpen={(id) => navigate(`/deals/${id}`)} />
        <div className="space-y-4">
          <StrategicAlertsPanel alerts={derived.alerts} />
          <AiBlindSpotsPanel items={derived.blindSpots} />
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="grid grid-cols-2 divide-x divide-slate-100 border-b border-slate-100 lg:grid-cols-4">
            <KpiTile label="Leads" value={data.activeLeads.count} subtext={`${data.activeLeads.count} active`} to="/leads?scope=mine" />
            <KpiTile label="Qualified" value={qualifiedCount} subtext={`${qualifiedCount} active`} to="/leads?bucket=qualified_lead&scope=mine" />
            <KpiTile label="Opportunities" value={opportunityCount} subtext={formatCompactUsd(opportunityValue)} to={opportunitiesPath} />
            <KpiTile label="Bid Board" value={bidBoardCount} subtext={formatCompactUsd(bidBoardValue)} to={bidBoardPath} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between border-b border-slate-100 pb-3">
          <CardTitle className="text-sm font-bold uppercase tracking-[0.16em] text-slate-950">MY NUMBERS</CardTitle>
          <ActivityRangeSelect value={numbersRange} onChange={setNumbersRange} className="h-8 w-[140px] text-xs" />
        </CardHeader>
        <CardContent className="space-y-5 pt-5">
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
            <MetricCell
              label="Cleanup"
              value={data.myCleanup.total}
              subtitle={`${derived.ownershipGaps} ownership gaps`}
              emphasis={data.myCleanup.total > 0 ? "warning" : "neutral"}
              to="/pipeline/my-cleanup"
            />
            <MetricCell
              label="Stale leads"
              value={data.staleLeads.count}
              subtitle={`${staleAge}+ days`}
              emphasis={data.staleLeads.count > 0 ? "warning" : "neutral"}
              to="/leads?stale=true&scope=mine"
            />
            <MetricCell
              label="Follow-up"
              value={`${data.followUpCompliance.complianceRate}%`}
              subtitle={`${data.followUpCompliance.onTime} of ${data.followUpCompliance.total} on time`}
              emphasis={data.followUpCompliance.complianceRate < 80 ? "warning" : "neutral"}
              to="/tasks"
            />
            <MetricCell
              label="Overdue"
              value={Math.max(data.tasksToday.overdue, overdueTasks.length)}
              subtitle="tasks"
              emphasis={data.tasksToday.overdue > 0 || overdueTasks.length > 0 ? "danger" : "neutral"}
              to="/tasks?filter=overdue"
            />
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-slate-100 pt-5 sm:grid-cols-4">
            <MetricCell label="Calls" value={data.activityThisWeek.calls} to="/reports/performance" />
            <MetricCell label="Emails" value={data.activityThisWeek.emails} to="/reports/performance" />
            <MetricCell label="Meetings" value={data.activityThisWeek.meetings} to="/reports/performance" />
            <MetricCell label="Notes" value={data.activityThisWeek.notes} to="/reports/performance" />
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
        <Link to="/reports/performance" className={cn(buttonVariants({ variant: "outline", size: "lg" }))}>
          Performance report
          <ArrowUpRight className="ml-1.5 h-4 w-4" />
        </Link>
        <Link
          to={activeDealsPath}
          className={cn(buttonVariants({ variant: "default", size: "lg" }), "bg-brand-red text-white hover:bg-brand-red/90")}
        >
          Open my pipeline
          <ArrowUpRight className="ml-1.5 h-4 w-4" />
        </Link>
      </div>
    </div>
  );
}
