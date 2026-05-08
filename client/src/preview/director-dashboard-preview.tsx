import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Crown,
  ChevronRight,
  RefreshCw,
  Sparkles,
  Activity,
  Phone,
  Mail,
  Calendar,
  Users,
  CheckCircle2,
  XCircle,
  Target,
  Flame,
  ArrowDownToLine,
  MoreHorizontal,
  ArrowUpRight,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EYEBROW, MetricCard } from "./preview-shared";

const PERIODS = ["MTD", "QTD", "YTD", "Last month", "Last quarter", "Last year"] as const;
type Period = (typeof PERIODS)[number];

const USD = (value: number, compact = false): string => {
  const opts: Intl.NumberFormatOptions = compact
    ? { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }
    : { style: "currency", currency: "USD", maximumFractionDigits: 0 };
  return new Intl.NumberFormat("en-US", opts).format(value);
};

type RepPerformance = {
  id: string;
  name: string;
  initials: string;
  region: string;
  activeDeals: number;
  pipelineValue: number;
  closedValue: number;
  atRiskCount: number;
  winRate: number;
  winRateDelta: number;
  trend: number[]; // last 8 weeks pipeline values
  activityLevel: "high" | "moderate" | "low";
  status: "active" | "review" | "needs_help";
};

const reps: RepPerformance[] = [
  { id: "u2", name: "Kevin Scott", initials: "KS", region: "North DFW", activeDeals: 7, pipelineValue: 3_200_000, closedValue: 5_120_000, atRiskCount: 0, winRate: 0.55, winRateDelta: 0.04, trend: [2.4, 2.6, 2.7, 2.9, 3.0, 3.1, 3.0, 3.2], activityLevel: "high", status: "active" },
  { id: "u3", name: "Chris Higginbotham", initials: "CH", region: "East Texas", activeDeals: 6, pipelineValue: 2_400_000, closedValue: 3_840_000, atRiskCount: 1, winRate: 0.48, winRateDelta: -0.02, trend: [2.0, 2.1, 2.2, 2.3, 2.5, 2.5, 2.4, 2.4], activityLevel: "moderate", status: "active" },
  { id: "u1", name: "Brett Rios", initials: "BR", region: "Dallas-Fort Worth", activeDeals: 9, pipelineValue: 4_540_000, closedValue: 1_980_000, atRiskCount: 3, winRate: 0.42, winRateDelta: 0.01, trend: [3.8, 4.0, 4.2, 4.3, 4.5, 4.6, 4.5, 4.5], activityLevel: "high", status: "review" },
  { id: "u4", name: "Alex Koch", initials: "AK", region: "South DFW", activeDeals: 5, pipelineValue: 1_800_000, closedValue: 2_040_000, atRiskCount: 1, winRate: 0.39, winRateDelta: -0.05, trend: [2.0, 1.9, 1.9, 1.8, 1.8, 1.7, 1.8, 1.8], activityLevel: "moderate", status: "review" },
  { id: "u5", name: "Eric Williams", initials: "EW", region: "Central DFW", activeDeals: 4, pipelineValue: 1_200_000, closedValue: 0, atRiskCount: 2, winRate: 0.0, winRateDelta: -0.15, trend: [1.5, 1.4, 1.3, 1.3, 1.3, 1.2, 1.2, 1.2], activityLevel: "low", status: "needs_help" },
];

type AtRiskDeal = {
  id: string;
  name: string;
  account: string;
  ownerInitials: string;
  ownerName: string;
  stage: string;
  daysInStage: number;
  sla: number;
  value: number;
  risk: "stale" | "no_activity" | "blocked" | "missing_decision_maker";
  riskLabel: string;
};

const atRiskDeals: AtRiskDeal[] = [
  { id: "1", name: "Dallas ISD Roof Replacement", account: "Dallas Independent SD", ownerInitials: "BR", ownerName: "Brett Rios", stage: "Estimating", daysInStage: 22, sla: 14, value: 875_000, risk: "stale", riskLabel: "8 days over SLA" },
  { id: "8", name: "Carrollton Logistics Hub", account: "Carrollton Properties", ownerInitials: "BR", ownerName: "Brett Rios", stage: "Estimating", daysInStage: 18, sla: 14, value: 680_000, risk: "stale", riskLabel: "4 days over SLA" },
  { id: "m1", name: "McKinney Medical Plaza", account: "McKinney Health Group", ownerInitials: "EW", ownerName: "Eric Williams", stage: "Sales Validation", daysInStage: 28, sla: 21, value: 1_460_000, risk: "no_activity", riskLabel: "No touch in 14 days" },
  { id: "p1", name: "Plano Office Tower Re-Cover", account: "Plano Tower LP", ownerInitials: "BR", ownerName: "Brett Rios", stage: "Estimating", daysInStage: 12, sla: 14, value: 320_000, risk: "missing_decision_maker", riskLabel: "Missing decision maker" },
  { id: "a1", name: "Allen ISD Maintenance Agreement", account: "Allen ISD", ownerInitials: "AK", ownerName: "Alex Koch", stage: "Contract", daysInStage: 9, sla: 7, value: 240_000, risk: "blocked", riskLabel: "Awaiting board approval" },
];

type Alert = {
  id: string;
  severity: "critical" | "warning" | "info";
  title: string;
  detail: string;
  cta?: string;
};

const strategicAlerts: Alert[] = [
  { id: "a1", severity: "critical", title: "Pipeline gap: $2.4M behind QTD goal", detail: "6 weeks remaining · need 2 wins ≥ $1M to recover", cta: "Open forecast" },
  { id: "a2", severity: "warning", title: "Brett: 3 deals past SLA in Estimating", detail: "$1.88M of pipeline at risk · longest 22 days", cta: "Schedule 1:1" },
  { id: "a3", severity: "critical", title: "Eric: 0 closed deals this quarter", detail: "Win rate dropped 15% · activity below target", cta: "Coaching plan" },
  { id: "a4", severity: "warning", title: "Win rate down 8% week-over-week", detail: "Lost 4 of last 9 in Estimate Sent stage", cta: "Win/loss review" },
];

type Coaching = {
  id: string;
  rep: string;
  repInitials: string;
  insight: string;
  suggestion: string;
  cta: string;
};

const coaching: Coaching[] = [
  { id: "c1", rep: "Eric Williams", repInitials: "EW", insight: "Pipeline contracted 20% over last 4 weeks", suggestion: "Schedule a working session — focus on opportunity creation", cta: "Schedule 1:1" },
  { id: "c2", rep: "Brett Rios", repInitials: "BR", insight: "Estimating SLA breached on 3 deals", suggestion: "Review pricing template + estimator capacity", cta: "Open process review" },
  { id: "c3", rep: "Alex Koch", repInitials: "AK", insight: "Win rate dropped 5% · all losses in Estimate Sent", suggestion: "Run win/loss interviews on last 4 lost deals", cta: "Add to plan" },
];

type ActivityPulse = {
  rep: string;
  initials: string;
  calls: number;
  emails: number;
  meetings: number;
  total: number;
};

const activityPulse: ActivityPulse[] = [
  { rep: "Kevin Scott", initials: "KS", calls: 28, emails: 54, meetings: 9, total: 91 },
  { rep: "Brett Rios", initials: "BR", calls: 24, emails: 41, meetings: 6, total: 71 },
  { rep: "Chris Higginbotham", initials: "CH", calls: 22, emails: 36, meetings: 7, total: 65 },
  { rep: "Alex Koch", initials: "AK", calls: 14, emails: 28, meetings: 4, total: 46 },
  { rep: "Eric Williams", initials: "EW", calls: 6, emails: 18, meetings: 1, total: 25 },
];

type RecentClose = {
  id: string;
  outcome: "won" | "lost";
  name: string;
  value: number;
  rep: string;
  repInitials: string;
  reason?: string;
  closedAt: string;
};

const recentCloses: RecentClose[] = [
  { id: "rc1", outcome: "won", name: "Allen Sports Complex", value: 2_240_000, rep: "Kevin Scott", repInitials: "KS", reason: "Repeat customer · trust", closedAt: "yesterday" },
  { id: "rc2", outcome: "won", name: "Skyline Auditorium Closeout", value: 320_000, rep: "Brett Rios", repInitials: "BR", reason: "Bundle deal", closedAt: "Apr 24" },
  { id: "rc3", outcome: "lost", name: "Lewisville Office Park", value: 380_000, rep: "Eric Williams", repInitials: "EW", reason: "Lost on price", closedAt: "Apr 22" },
  { id: "rc4", outcome: "won", name: "Garland Office Tower", value: 685_000, rep: "Chris Higginbotham", repInitials: "CH", closedAt: "Apr 18" },
  { id: "rc5", outcome: "lost", name: "Frisco Logistics Phase 1", value: 1_200_000, rep: "Alex Koch", repInitials: "AK", reason: "Timing · wanted earlier start", closedAt: "Apr 15" },
];

function Sparkline({ data }: { data: number[] }) {
  if (data.length === 0) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const w = 80;
  const h = 24;
  const points = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * w;
      const y = h - ((v - min) / range) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const trendPositive = data[data.length - 1]! >= data[0]!;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-6 w-20" preserveAspectRatio="none">
      <polyline
        fill="none"
        strokeWidth="1.5"
        stroke={trendPositive ? "#10b981" : "#CC0000"}
        points={points}
      />
      <circle
        cx={(w / (data.length - 1)) * (data.length - 1)}
        cy={h - ((data[data.length - 1]! - min) / range) * h}
        r="2"
        fill={trendPositive ? "#10b981" : "#CC0000"}
      />
    </svg>
  );
}

function ActivityDot({ level }: { level: "high" | "moderate" | "low" }) {
  const styles = {
    high: { tone: "bg-emerald-500", label: "High" },
    moderate: { tone: "bg-amber-400", label: "Moderate" },
    low: { tone: "bg-brand-red", label: "Low" },
  } as const;
  const s = styles[level];
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${s.tone}`} />
      <span className="text-xs font-semibold text-slate-700">{s.label}</span>
    </span>
  );
}

export function DirectorDashboardPreview() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState<Period>("QTD");

  const totalPipeline = reps.reduce((s, r) => s + r.pipelineValue, 0);
  const totalClosed = reps.reduce((s, r) => s + r.closedValue, 0);
  const totalAtRisk = reps.reduce((s, r) => s + r.atRiskCount, 0);
  const teamGoal = 14_500_000;
  const goalPct = (totalClosed / teamGoal) * 100;
  const totalActivity = activityPulse.reduce((s, r) => s + r.total, 0);
  const maxRepPipeline = Math.max(...reps.map((r) => r.pipelineValue));

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-4xl font-black uppercase tracking-tight text-slate-950 md:text-5xl">Director Dashboard</h1>
          <p className="mt-2 text-[11px] font-bold uppercase tracking-[0.24em] text-slate-500">
            Strategic performance overview · synced just now
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 rounded-full bg-slate-100 p-1">
            {PERIODS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPeriod(p)}
                className={`rounded-full px-3 py-1.5 text-xs font-bold transition-colors ${
                  period === p ? "bg-brand-red text-white shadow-sm" : "text-slate-600 hover:text-slate-900"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
          <Button variant="outline" size="sm">
            <RefreshCw className="mr-1 h-4 w-4" />
            Refresh
          </Button>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <MetricCard
          eyebrow="Active pipeline"
          value={USD(totalPipeline, true)}
          badge={`${reps.reduce((s, r) => s + r.activeDeals, 0)} deals`}
          badgeTone="green"
          caption="Weighted forecast"
          accent="red"
        />
        <MetricCard
          eyebrow={`Closed ${period}`}
          value={USD(totalClosed, true)}
          badge={`${goalPct.toFixed(0)}% to goal`}
          badgeTone="blue"
          caption={`Goal ${USD(teamGoal, true)} ${period}`}
          accent="blue"
        />
        <MetricCard
          eyebrow="At risk"
          value={String(totalAtRisk)}
          badge={`${USD(atRiskDeals.reduce((s, d) => s + d.value, 0), true)} blocked`}
          drenched
          caption={`${atRiskDeals.length} flagged deals across ${reps.filter((r) => r.atRiskCount > 0).length} reps`}
        />
      </div>

      <Card>
        <CardContent className="p-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className={EYEBROW}>Forecast vs goal</p>
              <p className="mt-1 text-3xl font-black tracking-tight text-slate-950">
                {USD(totalClosed, true)} <span className="text-lg font-bold text-slate-500">/ {USD(teamGoal, true)}</span>
              </p>
              <p className="mt-1 text-xs text-slate-600">
                {goalPct < 100 ? (
                  <>
                    <span className="font-bold text-brand-red">{USD(teamGoal - totalClosed, true)} behind goal</span> · 6 weeks remaining
                  </>
                ) : (
                  <>
                    <span className="font-bold text-emerald-700">Goal exceeded by {USD(totalClosed - teamGoal, true)}</span>
                  </>
                )}
              </p>
            </div>
            <div className="flex flex-wrap gap-3 text-sm">
              <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50/40 px-3 py-2">
                <Target className="h-4 w-4 text-brand-red" />
                <div className="leading-none">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Pace</p>
                  <p className="mt-1 font-black text-slate-950">{goalPct < 80 ? "Behind" : goalPct < 100 ? "On pace" : "Ahead"}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50/40 px-3 py-2">
                <Flame className="h-4 w-4 text-amber-500" />
                <div className="leading-none">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Closing</p>
                  <p className="mt-1 font-black text-slate-950">{atRiskDeals.filter((d) => d.stage === "Contract").length} this week</p>
                </div>
              </div>
              <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50/40 px-3 py-2">
                <Activity className="h-4 w-4 text-blue-500" />
                <div className="leading-none">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Activity</p>
                  <p className="mt-1 font-black text-slate-950">{totalActivity} this week</p>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-5 space-y-2">
            <div className="flex items-center gap-3 text-xs">
              <p className="w-12 font-bold uppercase tracking-wide text-slate-500">Won</p>
              <div className="flex h-3 flex-1 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="bg-emerald-500"
                  style={{ width: `${Math.min(100, goalPct)}%` }}
                />
                <div
                  className="bg-brand-red/30"
                  style={{ width: `${Math.max(0, 100 - goalPct)}%` }}
                />
              </div>
              <p className="w-12 font-black tabular-nums text-slate-950">{goalPct.toFixed(0)}%</p>
            </div>
            <div className="flex items-center gap-3 text-xs">
              <p className="w-12 font-bold uppercase tracking-wide text-slate-500">Pipe</p>
              <div className="flex h-3 flex-1 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="bg-blue-400"
                  style={{ width: `${Math.min(100, (totalPipeline / teamGoal) * 100)}%` }}
                />
              </div>
              <p className="w-12 font-black tabular-nums text-slate-950">
                {((totalPipeline / teamGoal) * 100).toFixed(0)}%
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(320px,1fr)]">
        <div className="space-y-4">
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
              <div>
                <p className="text-sm font-bold uppercase tracking-[0.16em] text-slate-950">Sales force performance</p>
                <p className="mt-0.5 text-xs text-slate-500">Click rep for full breakdown</p>
              </div>
              <Button variant="outline" size="sm">
                <ArrowDownToLine className="mr-1 h-4 w-4" />
                Export
              </Button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px]">
                <thead>
                  <tr className="border-b border-slate-100 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
                    <th className="px-5 py-3 text-left">Rep</th>
                    <th className="px-5 py-3 text-right">Closed</th>
                    <th className="px-5 py-3 text-right">Pipeline</th>
                    <th className="px-5 py-3 text-left">Distribution</th>
                    <th className="px-5 py-3 text-right">Win rate</th>
                    <th className="px-5 py-3 text-right">At risk</th>
                    <th className="px-5 py-3 text-left">Activity</th>
                    <th className="px-5 py-3 text-left">Trend</th>
                    <th className="w-10 px-5 py-3" aria-hidden />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {reps.map((r, i) => {
                    const isLeader = i === 0;
                    const pipePct = (r.pipelineValue / maxRepPipeline) * 100;
                    return (
                      <tr
                        key={r.id}
                        onClick={() => navigate(`/director/rep/${r.id}`)}
                        className="cursor-pointer transition-colors hover:bg-slate-50"
                      >
                        <td className="px-5 py-4">
                          <div className="flex items-center gap-3">
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-red text-[11px] font-black uppercase text-white">
                              {r.initials}
                            </span>
                            <div>
                              <div className="flex items-center gap-1.5">
                                <p className="font-bold text-slate-950">{r.name}</p>
                                {isLeader ? (
                                  <Crown className="h-3.5 w-3.5 fill-amber-400 stroke-amber-500" />
                                ) : null}
                              </div>
                              <div className="mt-0.5 flex items-center gap-1.5">
                                <p className="text-xs text-slate-500">{r.region}</p>
                                {r.status === "needs_help" ? (
                                  <span className="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded-full bg-brand-red/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-brand-red ring-1 ring-brand-red/20">
                                    Needs help
                                  </span>
                                ) : null}
                                {r.status === "review" ? (
                                  <span className="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded-full bg-amber-50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-700 ring-1 ring-amber-200">
                                    Review
                                  </span>
                                ) : null}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="px-5 py-4 text-right">
                          <p className="text-sm font-black tabular-nums text-slate-950">{USD(r.closedValue, true)}</p>
                        </td>
                        <td className="px-5 py-4 text-right">
                          <p className="text-sm font-black tabular-nums text-slate-700">{USD(r.pipelineValue, true)}</p>
                          <p className="mt-0.5 text-[10px] tabular-nums text-slate-500">{r.activeDeals} deals</p>
                        </td>
                        <td className="px-5 py-4">
                          <div className="h-1.5 w-32 overflow-hidden rounded-full bg-slate-100">
                            <div
                              className="h-full rounded-full bg-brand-red/80"
                              style={{ width: `${pipePct}%` }}
                            />
                          </div>
                        </td>
                        <td className="px-5 py-4 text-right">
                          <span className="inline-flex items-center gap-1 text-sm font-bold tabular-nums">
                            {r.winRateDelta > 0 ? (
                              <TrendingUp className="h-3 w-3 text-emerald-500" />
                            ) : r.winRateDelta < 0 ? (
                              <TrendingDown className="h-3 w-3 text-brand-red" />
                            ) : null}
                            <span
                              className={
                                r.winRate >= 0.5
                                  ? "text-emerald-700"
                                  : r.winRate >= 0.3
                                    ? "text-slate-700"
                                    : "text-brand-red"
                              }
                            >
                              {(r.winRate * 100).toFixed(0)}%
                            </span>
                          </span>
                          {r.winRateDelta !== 0 ? (
                            <p
                              className={`text-[10px] tabular-nums ${
                                r.winRateDelta > 0 ? "text-emerald-600" : "text-brand-red"
                              }`}
                            >
                              {r.winRateDelta > 0 ? "+" : ""}
                              {(r.winRateDelta * 100).toFixed(0)}pp
                            </p>
                          ) : null}
                        </td>
                        <td className="px-5 py-4 text-right">
                          {r.atRiskCount > 0 ? (
                            <span className="inline-flex items-center rounded-full bg-brand-red/10 px-2 py-0.5 text-[11px] font-bold tabular-nums text-brand-red ring-1 ring-brand-red/20">
                              {r.atRiskCount}
                            </span>
                          ) : (
                            <span className="text-xs text-slate-400">—</span>
                          )}
                        </td>
                        <td className="px-5 py-4">
                          <ActivityDot level={r.activityLevel} />
                        </td>
                        <td className="px-5 py-4">
                          <Sparkline data={r.trend} />
                        </td>
                        <td className="px-5 py-4 text-right">
                          <ChevronRight className="ml-auto h-4 w-4 text-slate-400" />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-brand-red" />
                <p className="text-sm font-bold uppercase tracking-[0.16em] text-slate-950">At-risk deals</p>
                <span className="rounded-full bg-brand-red/10 px-2 py-0.5 text-[10px] font-black tabular-nums text-brand-red">
                  {atRiskDeals.length}
                </span>
              </div>
              <Button variant="outline" size="sm">
                Open all
                <ChevronRight className="ml-1 h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="divide-y divide-slate-100">
              {atRiskDeals.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => navigate(`/deals/${d.id}`)}
                  className="grid w-full grid-cols-[1fr_auto_auto_auto] items-center gap-4 px-5 py-3 text-left transition-colors hover:bg-slate-50"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-red text-[10px] font-black uppercase text-white">
                      {d.ownerInitials}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold text-slate-950">{d.name}</p>
                      <div className="mt-0.5 flex items-center gap-1.5">
                        <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700 ring-1 ring-amber-200">
                          {d.stage}
                        </span>
                        <p className="truncate text-xs text-slate-500">
                          {d.ownerName} · {d.account}
                        </p>
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-black tabular-nums text-brand-red">{d.daysInStage}d</p>
                    <p className="mt-0.5 text-[10px] tabular-nums text-slate-500">SLA {d.sla}d</p>
                  </div>
                  <p className="text-right text-sm font-black tabular-nums text-slate-950">{USD(d.value, true)}</p>
                  <span className="inline-flex items-center rounded-full bg-brand-red/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand-red ring-1 ring-brand-red/20">
                    {d.riskLabel}
                  </span>
                </button>
              ))}
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <Card className="relative overflow-hidden border-0 bg-[#0F172A] text-white">
            <CardContent className="p-5">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-400" />
                <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-white">Strategic alerts</p>
                <span className="ml-auto rounded-full bg-white/15 px-2 py-0.5 text-[10px] font-black tabular-nums text-white">
                  {strategicAlerts.length}
                </span>
              </div>
              <div className="mt-4 space-y-3">
                {strategicAlerts.map((a) => {
                  const tone = a.severity === "critical" ? "bg-brand-red" : a.severity === "warning" ? "bg-amber-400" : "bg-blue-400";
                  return (
                    <div key={a.id} className="flex gap-3 rounded-md bg-white/5 p-3">
                      <span className={`block w-1 shrink-0 rounded-full ${tone}`} aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-bold text-white">{a.title}</p>
                        <p className="mt-1 text-xs text-slate-400">{a.detail}</p>
                        {a.cta ? (
                          <button
                            type="button"
                            className="mt-2 inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-white hover:text-amber-400"
                          >
                            {a.cta}
                            <ArrowUpRight className="h-3 w-3" />
                          </button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-violet-500" />
                <p className="text-sm font-bold uppercase tracking-[0.16em] text-slate-950">AI coaching</p>
              </div>
              <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-700 ring-1 ring-violet-200">
                {coaching.length} insights
              </span>
            </div>
            <div className="divide-y divide-slate-100">
              {coaching.map((c) => (
                <div key={c.id} className="px-5 py-4">
                  <div className="flex items-center gap-2">
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-red text-[10px] font-black uppercase text-white">
                      {c.repInitials}
                    </span>
                    <p className="text-sm font-bold text-slate-950">{c.rep}</p>
                  </div>
                  <p className="mt-2 text-xs font-semibold text-slate-700">{c.insight}</p>
                  <p className="mt-1 text-xs text-slate-500">{c.suggestion}</p>
                  <button
                    type="button"
                    className="mt-2 inline-flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-brand-red hover:text-brand-red/80"
                  >
                    {c.cta}
                    <ChevronRight className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-slate-500" />
              <p className="text-sm font-bold uppercase tracking-[0.16em] text-slate-950">Activity pulse · this week</p>
            </div>
            <p className="text-xs font-semibold text-slate-500 tabular-nums">{totalActivity} total</p>
          </div>
          <div className="divide-y divide-slate-100">
            {activityPulse.map((a) => {
              const max = Math.max(...activityPulse.map((x) => x.total));
              const pct = (a.total / max) * 100;
              return (
                <div key={a.rep} className="flex items-center gap-4 px-5 py-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-red text-[10px] font-black uppercase text-white">
                    {a.initials}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-bold text-slate-950">{a.rep}</p>
                      <p className="text-sm font-black tabular-nums text-slate-700">{a.total}</p>
                    </div>
                    <div className="mt-1.5 flex h-2 overflow-hidden rounded-sm bg-slate-100">
                      <div className="bg-emerald-500" style={{ width: `${(a.calls / a.total) * pct}%` }} />
                      <div className="bg-blue-500" style={{ width: `${(a.emails / a.total) * pct}%` }} />
                      <div className="bg-violet-500" style={{ width: `${(a.meetings / a.total) * pct}%` }} />
                    </div>
                    <div className="mt-1 flex items-center gap-3 text-[10px] font-semibold text-slate-500">
                      <span className="inline-flex items-center gap-1">
                        <Phone className="h-2.5 w-2.5 text-emerald-500" />
                        {a.calls}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Mail className="h-2.5 w-2.5 text-blue-500" />
                        {a.emails}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Calendar className="h-2.5 w-2.5 text-violet-500" />
                        {a.meetings}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              <p className="text-sm font-bold uppercase tracking-[0.16em] text-slate-950">Recent closes</p>
            </div>
            <p className="text-xs font-semibold text-slate-500">
              {recentCloses.filter((c) => c.outcome === "won").length} won · {recentCloses.filter((c) => c.outcome === "lost").length} lost
            </p>
          </div>
          <div className="divide-y divide-slate-100">
            {recentCloses.map((c) => (
              <div key={c.id} className="flex items-center gap-4 px-5 py-3">
                <span
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-1 ${
                    c.outcome === "won"
                      ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                      : "bg-brand-red/10 text-brand-red ring-brand-red/20"
                  }`}
                >
                  {c.outcome === "won" ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-bold text-slate-950">{c.name}</p>
                    <p className="shrink-0 text-sm font-black tabular-nums text-slate-950">{USD(c.value, true)}</p>
                  </div>
                  <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-slate-500">
                    <p className="truncate">
                      <span className="font-semibold">{c.rep}</span>
                      {c.reason ? ` · ${c.reason}` : ""}
                    </p>
                    <p className="shrink-0 font-semibold tabular-nums">{c.closedAt}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
