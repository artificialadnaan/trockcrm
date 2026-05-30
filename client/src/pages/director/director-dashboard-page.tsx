import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  useDirectorDashboard,
  presetToDateRange,
  type DateRangePreset,
  type RepPerformanceCard,
} from "@/hooks/use-director-dashboard";
import { useRepPerformance, type RepPerformancePeriodKind, type RepPerformanceSnapshotRow } from "@/hooks/use-rep-performance";
import { formatCurrency } from "@/components/charts/chart-colors";
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Bell,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  Download,
  Mail,
  Minus,
  Phone,
  RefreshCw,
  Sparkles,
  Target,
  Trophy,
  User,
  XCircle,
  Zap,
} from "lucide-react";
import { DIRECTOR_DASHBOARD_ACTIONS } from "@/lib/director-dashboard-actions";
import { getWorkflowRouteLabel } from "@/lib/pipeline-ownership";
import { ScopeToggle, type ScopeToggleOption } from "@/components/shared/scope-toggle";
import { useAuth } from "@/lib/auth";
import type { PipelineScope } from "@/lib/pipeline-scope";
import { resolvePreferredScope, writeStoredScopePreference } from "@/lib/scope-preferences";

const PRESETS: Array<{ value: DateRangePreset; label: string }> = [
  { value: "mtd", label: "MTD" },
  { value: "qtd", label: "QTD" },
  { value: "ytd", label: "YTD" },
  { value: "last_month", label: "Last month" },
  { value: "last_quarter", label: "Last quarter" },
  { value: "last_year", label: "Last year" },
];

const PERIOD_LABELS: Record<DateRangePreset, string> = {
  mtd: "MTD",
  qtd: "QTD",
  ytd: "YTD",
  last_month: "last month",
  last_quarter: "last quarter",
  last_year: "last year",
  custom: "selected period",
};

const PERIOD_ACTIVITY_LABELS: Record<DateRangePreset, string> = {
  mtd: "this month",
  qtd: "this quarter",
  ytd: "this year",
  last_month: "last month",
  last_quarter: "last quarter",
  last_year: "last year",
  custom: "selected period",
};

const SCOPE_OPTIONS = [
  { value: "mine", label: "Mine" },
  { value: "team", label: "Team" },
  { value: "all", label: "All" },
] as const satisfies readonly ScopeToggleOption<PipelineScope>[];

type ActivityLevel = { dot: string; label: "High" | "Moderate" | "Low" };

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

function getActivityLevel(score: number): ActivityLevel {
  if (score >= 70) return { dot: "bg-emerald-500", label: "High" };
  if (score >= 35) return { dot: "bg-amber-400", label: "Moderate" };
  return { dot: "bg-red-500", label: "Low" };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "--";
  return `${Math.round(value)}%`;
}

function buildRepDetailPath(repId: string, preset: DateRangePreset, focus?: string): string {
  const params = new URLSearchParams();
  params.set("preset", preset);
  if (focus) params.set("focus", focus);
  return `/director/rep/${repId}?${params.toString()}`;
}

function formatDelta(value: number | null | undefined, suffix = "") {
  if (value === null || value === undefined) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-bold text-gray-400">
        <Minus className="h-3 w-3" />
        --
      </span>
    );
  }
  if (value === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-bold text-gray-400">
        <Minus className="h-3 w-3" />
        0{suffix}
      </span>
    );
  }

  const Icon = value > 0 ? ArrowUpRight : ArrowDownRight;
  const color = value > 0 ? "text-emerald-600" : "text-red-600";
  const sign = value > 0 ? "+" : "";
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-bold ${color}`}>
      <Icon className="h-3 w-3" />
      {sign}
      {Math.round(value)}
      {suffix}
    </span>
  );
}

function relativeDate(value: string): string {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  const today = new Date();
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const dateUtc = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((todayUtc - dateUtc) / 86_400_000);
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays > 1 && diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function weeksRemaining(to: string): number | null {
  const [year, month, day] = to.split("-").map(Number);
  if (!year || !month || !day) return null;
  const endUtc = Date.UTC(year, month - 1, day, 23, 59, 59, 999);
  const now = new Date();
  const nowUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds(), now.getUTCMilliseconds());
  const diff = endUtc - nowUtc;
  return Math.max(0, Math.ceil(diff / (7 * 86_400_000)));
}

function periodEndForPreset(preset: DateRangePreset, dateRange: { from: string; to: string }): string {
  if (preset === "last_month" || preset === "last_quarter" || preset === "last_year" || preset === "custom") {
    return dateRange.to;
  }

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  if (preset === "mtd") {
    return `${year}-${String(month + 1).padStart(2, "0")}-${String(new Date(year, month + 1, 0).getDate()).padStart(2, "0")}`;
  }
  if (preset === "qtd") {
    const quarterEndMonth = Math.floor(month / 3) * 3 + 2;
    return `${year}-${String(quarterEndMonth + 1).padStart(2, "0")}-${String(new Date(year, quarterEndMonth + 1, 0).getDate()).padStart(2, "0")}`;
  }
  return `${year}-12-31`;
}

function formatFreshness(value: string | null | undefined): string {
  if (!value) return "sync pending";
  const fetchedAt = new Date(value).getTime();
  if (Number.isNaN(fetchedAt)) return "sync pending";
  const diffSeconds = Math.max(0, Math.floor((Date.now() - fetchedAt) / 1000));
  if (diffSeconds < 60) return "synced just now";
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `synced ${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `synced ${diffHours}h ago`;
  return `synced ${Math.floor(diffHours / 24)}d ago`;
}

function MiniSparkline({ values }: { values: number[] }) {
  if (values.length < 2) {
    return <span className="text-[11px] font-bold text-gray-400">--</span>;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = max - min || 1;
  const points = values
    .map((value, index) => {
      const x = (index / Math.max(values.length - 1, 1)) * 72;
      const y = 28 - ((value - min) / spread) * 24;
      return `${x},${y}`;
    })
    .join(" ");
  const rising = values[values.length - 1] >= values[0];

  return (
    <svg aria-label="Trend sparkline" viewBox="0 0 72 32" className="h-8 w-20">
      <polyline
        points={points}
        fill="none"
        stroke={rising ? "#059669" : "#CC0000"}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DistributionBar({ row }: { row?: { leads: number; qualifiedLeads: number; opportunities: number; estimating: number } }) {
  const parts = row
    ? [
        { label: "Leads", value: row.leads, color: "bg-gray-400" },
        { label: "Qualified", value: row.qualifiedLeads, color: "bg-blue-500" },
        { label: "Opportunity", value: row.opportunities, color: "bg-[#CC0000]" },
        { label: "Estimating", value: row.estimating, color: "bg-amber-500" },
      ]
    : [];
  const total = parts.reduce((sum, part) => sum + part.value, 0);

  if (!row || total === 0) {
    return <div className="h-2 w-28 rounded-full bg-gray-100" aria-label="No distribution data" />;
  }

  return (
    <div className="w-28">
      <div className="flex h-2 overflow-hidden rounded-full bg-gray-100" aria-label="Stage distribution">
        {parts.filter((part) => part.value > 0).map((part) => (
          <div
            key={part.label}
            title={`${part.label}: ${part.value}`}
            className={part.color}
            style={{ width: `${(part.value / total) * 100}%` }}
          />
        ))}
      </div>
    </div>
  );
}

function KpiCard({
  label,
  value,
  badge,
  caption,
  accent,
  dark = false,
  to,
  ariaLabel,
}: {
  label: string;
  value: string;
  badge: string;
  caption: string;
  accent: "red" | "blue";
  dark?: boolean;
  to?: string;
  ariaLabel?: string;
}) {
  const accentClass = accent === "red" ? "bg-[#CC0000]" : "bg-blue-500";
  const className = `group relative overflow-hidden rounded-xl border p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-[#CC0000] ${dark ? "border-[#CC0000] bg-[#CC0000] text-white" : "border-gray-200 bg-white text-gray-950"}`;

  const content = (
    <>
      <p className={`text-[10px] font-black uppercase tracking-widest ${dark ? "text-white/70" : "text-gray-400"}`}>{label}</p>
      <p className="mt-3 text-5xl font-black leading-none tracking-tight">{value}</p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-wide ${dark ? "bg-white/20 text-white" : "bg-gray-100 text-gray-800"}`}>
          {badge}
        </span>
        <span className={`text-[10px] font-bold uppercase tracking-wide ${dark ? "text-white/70" : "text-gray-400"}`}>{caption}</span>
      </div>
      {!dark && <div className={`absolute inset-x-0 bottom-0 h-1 ${accentClass}`} />}
    </>
  );

  if (!to) {
    return <div className={className}>{content}</div>;
  }

  return (
    <Link to={to} aria-label={ariaLabel} className={`${className} block cursor-pointer`}>
      {content}
    </Link>
  );
}

function ActionIcon({ severity }: { severity: "info" | "warning" | "critical" }) {
  if (severity === "critical") return "COACHING PLAN";
  if (severity === "warning") return "SCHEDULE 1:1";
  return "OPEN FORECAST";
}

function formatPathLabel(route: "normal" | "service") {
  return `${getWorkflowRouteLabel(route)} path`;
}

function csvCell(value: string | number | null | undefined): string {
  const raw = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function buildDealsDrilldownPath(
  filter: "active_pipeline" | "won" | "closing_soon" | "stale" | "at_risk",
  preset: DateRangePreset,
  scope: PipelineScope
) {
  if (filter === "stale" || filter === "at_risk") {
    return `/deals?filter=${filter}&scope=${scope}`;
  }
  return `/deals?filter=${filter}&period=${preset}&scope=${scope}`;
}

function buildReportDrilldownPath(
  basePath: string,
  preset: DateRangePreset,
  dateRange: { from: string; to: string },
  hash?: string
) {
  const params = new URLSearchParams();
  if (preset === "qtd" || preset === "ytd") {
    params.set("range", preset);
  } else {
    params.set("range", "custom");
    params.set("dateFrom", dateRange.from);
    params.set("dateTo", dateRange.to);
  }
  return `${basePath}?${params.toString()}${hash ? `#${hash}` : ""}`;
}

export function DirectorDashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [preset, setPreset] = useState<DateRangePreset>("qtd");
  const dateRange = presetToDateRange(preset);
  const repPerformancePeriod = preset as RepPerformancePeriodKind;
  const scope = resolvePreferredScope({
    requestedScope: searchParams.get("scope"),
    userId: user?.id,
    fallback: "mine",
  });
  const updateScope = (nextScope: PipelineScope) => {
    writeStoredScopePreference(user?.id, nextScope);
    const next = new URLSearchParams(searchParams);
    next.set("scope", nextScope);
    setSearchParams(next);
  };
  const { data, loading, error, refetch, lastFetchedAt } = useDirectorDashboard(dateRange, repPerformancePeriod, scope);
  const {
    data: perfData,
    loading: perfLoading,
    error: perfError,
    refetch: refetchPerformance,
  } = useRepPerformance(repPerformancePeriod);

  const selectedPreset = PRESETS.find((p) => p.value === preset) ?? PRESETS[1];
  const activeDealsDestination = buildDealsDrilldownPath("active_pipeline", preset, scope);
  const wonDealsDestination = buildDealsDrilldownPath("won", preset, scope);
  // This KPI is sourced from recent period closes, so it should drill into the
  // same closed-won slice rather than forecasted near-close deals.
  const closingDestination = buildDealsDrilldownPath("won", preset, scope);
  const forecastDestination = buildReportDrilldownPath("/reports/performance/forecast-accuracy", preset, dateRange);
  const activityDestination = buildReportDrilldownPath("/reports/performance/rep-activity", preset, dateRange);
  const staleDealsDestination = buildDealsDrilldownPath("stale", preset, scope);
  const atRiskDealsDestination = buildDealsDrilldownPath("at_risk", preset, scope);

  if (scope === "team") {
    return (
      <div className="min-h-screen space-y-6 bg-[#F5F4F2] p-4 sm:p-6">
        <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="text-3xl font-black uppercase tracking-tight text-gray-950 sm:text-4xl">
              Director Dashboard
            </h1>
            <p className="mt-1 text-[11px] font-bold uppercase tracking-widest text-gray-500">
              Team view is not yet configured
            </p>
          </div>
          <ScopeToggle options={SCOPE_OPTIONS} value={scope} onChange={updateScope} ariaLabel="Dashboard scope" />
        </header>

        <section className="rounded-3xl border border-dashed border-slate-300 bg-white px-8 py-14 text-center shadow-sm">
          <p className="text-[11px] font-black uppercase tracking-[0.22em] text-slate-500">Team Scope</p>
          <h2 className="mt-3 text-2xl font-black tracking-tight text-slate-950">Team view is not yet configured.</h2>
          <p className="mt-2 text-sm font-medium text-slate-500">Contact your admin to set up team groupings.</p>
        </section>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen space-y-5 bg-[#F5F4F2] p-6">
        <div className="h-28 rounded-xl bg-white shadow-sm animate-pulse" />
        <div className="grid grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="h-40 rounded-xl bg-white shadow-sm animate-pulse" />
          ))}
        </div>
        <div className="h-96 rounded-xl bg-white shadow-sm animate-pulse" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-[#F5F4F2] p-6">
        <h1 className="text-3xl font-black uppercase tracking-tight text-gray-950">Director Dashboard</h1>
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-6 text-red-700">{error}</div>
      </div>
    );
  }

  if (!data) return null;

  const opportunityVsPipeline = data.opportunityVsPipeline ?? {
    opportunityValue: data.ddVsPipeline.ddValue,
    opportunityCount: data.ddVsPipeline.ddCount,
    pipelineValue: data.ddVsPipeline.pipelineValue,
    pipelineCount: data.ddVsPipeline.pipelineCount,
    totalValue: data.ddVsPipeline.totalValue,
    totalCount: data.ddVsPipeline.totalCount,
  };

  const hasPerformanceData = Boolean(perfData) && !perfLoading && !perfError;
  const usablePerfData = hasPerformanceData ? perfData : null;
  const perfRowsByRep = new Map<string, RepPerformanceSnapshotRow>(
    (usablePerfData?.rows ?? []).map((row) => [row.repId, row])
  );
  const perfRepsByRep = new Map((usablePerfData?.reps ?? []).map((row) => [row.repId, row]));
  const funnelByRep = new Map(data.repFunnelRows.map((row) => [row.repId, row]));
  const activityPulse = (data.activityPulse ?? data.activityByRep).slice().sort((a, b) => b.total - a.total);
  const isUsingStaleDeals = data.staleDeals.length > 0;
  const atRiskDeals = isUsingStaleDeals ? data.staleDeals : data.atRiskDeals ?? [];
  const atRiskDestination = atRiskDealsDestination;
  const totalAtRiskValue = atRiskDeals.reduce((sum, deal) => sum + deal.dealValue, 0);
  const atRiskRepCount = new Set(atRiskDeals.map((deal) => deal.repName).filter(Boolean)).size;
  const engineAtRiskCountByRep = new Map<string, number>();
  for (const deal of data.atRiskDeals ?? []) {
    if (!deal.repId) continue;
    engineAtRiskCountByRep.set(deal.repId, (engineAtRiskCountByRep.get(deal.repId) ?? 0) + 1);
  }
  // Wave 1 (P0-1): page-level closed totals come from the AUTHORITATIVE Closed-card
  // aggregate (scopeSummary.won), so the forecast section's Closed exactly equals the
  // Closed KPI card and drilldown even when a Won deal's rep is unassigned or absent from
  // repCards. Per-rep rows still use the canonical repCards.closedValue decomposition.
  // Typed nullable to preserve the downstream goal/pace guards unchanged.
  const closedValue: number | null = data.scopeSummary?.won.totalValue ?? 0;
  const closedCount: number | null = data.scopeSummary?.won.count ?? 0;
  const forecastVsGoal = usablePerfData ? usablePerfData.forecastVsGoal : null;
  const goal = forecastVsGoal?.goal ?? 0;
  const forecast = forecastVsGoal?.forecast ?? 0;
  const wonPercent = goal > 0 && closedValue !== null ? clampPercent((closedValue / goal) * 100) : null;
  const pipePercent = hasPerformanceData && goal > 0 ? clampPercent((forecast / goal) * 100) : null;
  const goalGap = goal > 0 && closedValue !== null && goal > closedValue ? goal - closedValue : 0;
  const remainingWeeks = weeksRemaining(periodEndForPreset(preset, dateRange));
  const paceLabel = !hasPerformanceData ? "--" : goal > 0 && closedValue !== null && closedValue >= goal ? "Ahead" : (pipePercent ?? 0) >= 75 ? "On pace" : "Behind";
  const totalActivity = activityPulse.reduce((sum, row) => sum + row.total, 0);
  const strategicAlerts = data.strategicAlerts ?? [];
  const aiPrompts = data.aiCoachingPrompts ?? [];
  const recentCloses = data.recentCloses ?? [];
  const wonCloses = recentCloses.filter((close) => close.outcome === "won").length;
  const lostCloses = recentCloses.filter((close) => close.outcome === "lost").length;
  const repRows = [...data.repCards].sort((a, b) => b.pipelineValue - a.pipelineValue);
  const periodLabel = PERIOD_LABELS[preset];
  const activityPeriodLabel = PERIOD_ACTIVITY_LABELS[preset];
  const performanceUnavailable = perfLoading || Boolean(perfError);
  const scopeSummary = data.scopeSummary ?? {
    activePipeline: { count: 0, totalValue: 0 },
    won: { count: 0, totalValue: 0 },
    atRisk: { count: 0, totalValue: 0 },
    stale: { count: 0, totalValue: 0 },
  };

  function exportSalesForceCsv() {
    const header = ["Rep", "Region", "Closed Value", "Closed Deals", "Pipeline Value", "Active Deals", "Win Rate", "At Risk", "Activity"];
    const rows = repRows.map((rep) => {
      const snapshot = perfRowsByRep.get(rep.repId);
      const closed = rep.closedValue ?? 0; // Wave 1: canonical per-rep Won (reconciles with the card)
      const closedDeals = rep.winsCount ?? 0;
      const atRisk = engineAtRiskCountByRep.get(rep.repId) ?? 0;
      const activity = getActivityLevel(rep.activityScore);
      return [
        rep.repName,
        snapshot?.region ?? "",
        closed,
        closedDeals,
        rep.pipelineValue,
        rep.activeDeals,
        snapshot?.winRate ?? rep.winRate,
        atRisk,
        activity.label,
      ];
    });
    const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `director-sales-force-${preset}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="min-h-screen bg-[#F5F4F2] p-4 sm:p-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-3xl font-black uppercase tracking-tight text-gray-950 sm:text-4xl">
            Director Dashboard
          </h1>
          <p className="mt-1 text-[11px] font-bold uppercase tracking-widest text-gray-500">
            Strategic performance overview · {formatFreshness(lastFetchedAt)}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <ScopeToggle options={SCOPE_OPTIONS} value={scope} onChange={updateScope} ariaLabel="Dashboard scope" />
          <div className="flex flex-wrap items-center gap-1 rounded-full bg-gray-200 px-1.5 py-1.5">
            {PRESETS.map((item) => (
              <button
                key={item.value}
                data-testid={`preset-${item.value}`}
                type="button"
                onClick={() => setPreset(item.value)}
                className={`rounded-full px-3 py-1 text-xs font-black transition-colors ${
                  preset === item.value ? "bg-[#CC0000] text-white shadow-sm" : "text-gray-600 hover:text-gray-950"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            aria-label="Refresh dashboard"
            title="Refresh dashboard"
            onClick={() => {
              void refetch();
              void refetchPerformance();
            }}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-500 shadow-sm hover:text-gray-950"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          {DIRECTOR_DASHBOARD_ACTIONS.map((action) => {
            const Icon = action.key === "alerts" ? Bell : Activity;
            return (
              <button
                key={action.key}
                type="button"
                aria-label={action.label}
                title={action.title}
                onClick={() => navigate(action.to)}
                className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-500 shadow-sm hover:text-gray-950"
              >
                <Icon className="h-4 w-4" />
              </button>
            );
          })}
          <div className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-[#CC0000] text-white shadow-sm">
            <User className="h-4 w-4" />
          </div>
        </div>
      </header>

      <section className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <KpiCard
          label="Active pipeline"
          value={formatCurrency(scopeSummary.activePipeline.totalValue)}
          badge={`${scopeSummary.activePipeline.count} deals`}
          caption="Weighted forecast"
          accent="red"
          to={activeDealsDestination}
          ariaLabel="View active pipeline deals"
        />
        <KpiCard
          label={`Closed ${selectedPreset.label}`}
          value={formatCurrency(scopeSummary.won.totalValue)}
          badge={`${scopeSummary.won.count} won`}
          caption={perfError ? "Performance unavailable" : goal > 0 ? `Goal ${formatCurrency(goal)} ${selectedPreset.label}` : "Goal not configured"}
          accent="blue"
          to={wonDealsDestination}
          ariaLabel="View closed won deals"
        />
        <KpiCard
          label="At risk"
          value={String(scopeSummary.atRisk.count)}
          badge={`${formatCurrency(scopeSummary.atRisk.totalValue)} blocked`}
          caption={scope === "mine" ? "Your stale mirrored deals" : `${atRiskDeals.length} flagged deals across ${atRiskRepCount} reps`}
          accent="red"
          dark
          to={atRiskDestination}
          ariaLabel="View at-risk deals"
        />
      </section>

      {scope === "mine" ? (
        <section className="rounded-xl border border-slate-200 bg-white p-5 text-sm font-medium text-slate-600 shadow-sm">
          Mine scope currently applies to the KPI cards and drilldowns on this dashboard. Switch to All for office-wide director analytics.
        </section>
      ) : null}

      {scope === "all" ? (
      <section className="mt-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="grid gap-5 xl:grid-cols-[1fr_430px] xl:items-start">
          <Link
            to={forecastDestination}
            aria-label="View forecast accuracy report"
            className="block rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-[#CC0000]"
            title={goal > 0 ? "Open forecast accuracy report" : "Goal not configured. Open forecast accuracy report."}
          >
            <p className="text-[10px] font-black uppercase tracking-widest text-gray-400">Forecast vs goal</p>
            {performanceUnavailable && (
              <p className={`mt-2 rounded-lg border px-3 py-2 text-sm font-semibold ${perfError ? "border-red-200 bg-red-50 text-red-700" : "border-gray-200 bg-gray-50 text-gray-500"}`}>
                {perfError ?? "Loading performance metrics"}
              </p>
            )}
            <p className="mt-2 text-4xl font-black tracking-tight text-gray-950">
              {hasPerformanceData && closedValue !== null ? formatCurrency(closedValue) : "--"} / {goal > 0 ? formatCurrency(goal) : "--"}
            </p>
            <p className={`mt-1 text-sm font-semibold ${goalGap > 0 ? "text-[#CC0000]" : "text-emerald-600"}`}>
              {!hasPerformanceData
                ? "Performance metrics pending"
                : goalGap > 0
                ? `${formatCurrency(goalGap)} behind goal · ${remainingWeeks ?? "--"} weeks remaining`
                : "Goal met or ahead · current period"}
            </p>
          </Link>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Link
              to={forecastDestination}
              aria-label="View forecast pace details"
              className="rounded-lg border border-gray-200 bg-gray-50 p-3 transition-colors hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#CC0000]"
            >
              <Target className="h-4 w-4 text-[#CC0000]" />
              <p className="mt-2 text-[10px] font-black uppercase tracking-widest text-gray-400">Pace</p>
              <p className="mt-1 font-black text-gray-950">{paceLabel}</p>
            </Link>
            <Link
              to={closingDestination}
              aria-label="View recent closed deals"
              className="rounded-lg border border-gray-200 bg-gray-50 p-3 transition-colors hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#CC0000]"
            >
              <Trophy className="h-4 w-4 text-emerald-600" />
              <p className="mt-2 text-[10px] font-black uppercase tracking-widest text-gray-400">Closing</p>
              <p className="mt-1 font-black text-gray-950">{wonCloses} {activityPeriodLabel}</p>
            </Link>
            <Link
              to={activityDestination}
              aria-label="View activity report"
              className="rounded-lg border border-gray-200 bg-gray-50 p-3 transition-colors hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#CC0000]"
            >
              <Zap className="h-4 w-4 text-blue-600" />
              <p className="mt-2 text-[10px] font-black uppercase tracking-widest text-gray-400">Activity</p>
              <p className="mt-1 font-black text-gray-950">{totalActivity} {activityPeriodLabel}</p>
            </Link>
          </div>
        </div>

        <div className="mt-6 space-y-3">
          <div className="grid grid-cols-[52px_1fr_48px] items-center gap-3">
            <span className="text-[10px] font-black uppercase tracking-widest text-gray-500">Won</span>
            <div className="h-3 overflow-hidden rounded-full bg-gray-100">
              <div className="h-full rounded-full bg-[#CC0000]" style={{ width: `${wonPercent ?? 0}%` }} />
            </div>
            <span className="text-right text-[11px] font-black text-gray-700">{wonPercent === null ? "--" : `${wonPercent}%`}</span>
          </div>
          <div className="grid grid-cols-[52px_1fr_48px] items-center gap-3">
            <span className="text-[10px] font-black uppercase tracking-widest text-gray-500">Pipe</span>
            <div className="h-3 overflow-hidden rounded-full bg-gray-100">
              <div className="h-full rounded-full bg-blue-500" style={{ width: `${pipePercent ?? 0}%` }} />
            </div>
            <span className="text-right text-[11px] font-black text-gray-700">{pipePercent === null ? "--" : `${pipePercent}%`}</span>
          </div>
        </div>
      </section>
      ) : null}

      {scope === "all" ? (
      <section className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_390px]">
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="flex items-start justify-between gap-3 border-b border-gray-100 px-5 py-4">
            <div>
              <h2 className="text-sm font-black uppercase tracking-wide text-gray-950">Sales Force Performance</h2>
              <p className="mt-1 text-xs text-gray-500">Click rep for full breakdown</p>
            </div>
            <button
              type="button"
              data-testid="export-sales-force-csv"
              onClick={exportSalesForceCsv}
              className="inline-flex items-center gap-2 rounded-full border border-gray-200 px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-gray-600 hover:text-gray-950"
            >
              <Download className="h-3.5 w-3.5" />
              Export
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-sm" data-testid="director-leaderboard">
              <thead>
                <tr className="bg-gray-100 text-[10px] font-black uppercase tracking-widest text-gray-500">
                  <th className="px-5 py-3 text-left">Rep</th>
                  <th className="px-4 py-3 text-right">Closed</th>
                  <th className="px-4 py-3 text-right">Pipeline</th>
                  <th className="px-4 py-3 text-left">Distribution</th>
                  <th className="px-4 py-3 text-right">Win rate</th>
                  <th className="px-4 py-3 text-center">At risk</th>
                  <th className="px-4 py-3 text-left">Activity</th>
                  <th className="px-5 py-3 text-center">Trend</th>
                </tr>
              </thead>
              <tbody>
                {repRows.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-5 py-10 text-center text-sm text-gray-400">
                      No active reps found.
                    </td>
                  </tr>
                )}
                {repRows.map((rep) => {
                  const snapshot = perfRowsByRep.get(rep.repId);
                  const perfRep = perfRepsByRep.get(rep.repId);
                  // Wave 1 (P0-1): canonical per-rep Won from the director payload
                  // (reconciles with the Closed card); replaces the stale snapshot value.
                  const closed: number | null = rep.closedValue ?? null;
                  const closedDeals: number | null = rep.winsCount ?? null;
                  const winRate = hasPerformanceData ? snapshot?.winRate ?? rep.winRate : null;
                  const winDelta = hasPerformanceData && winRate !== null
                    ? snapshot?.previous ? winRate - snapshot.previous.winRate : perfRep?.change.winRate ?? null
                    : null;
                  const atRisk = engineAtRiskCountByRep.get(rep.repId) ?? 0;
                  const activity = getActivityLevel(rep.activityScore);
                  const needsHelp = atRisk > 0 || activity.label === "Low";

                  return (
                    <tr key={rep.repId} className="group border-t border-gray-100 hover:bg-gray-50">
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-3">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#CC0000] text-[11px] font-black text-white">
                            {getInitials(rep.repName)}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <Link to={buildRepDetailPath(rep.repId, preset)} className="font-bold text-gray-950 hover:text-[#CC0000]" data-testid={`rep-link-${rep.repId}`}>
                                {rep.repName}
                              </Link>
                              {needsHelp && (
                                <span className={`rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-wide ${activity.label === "Low" ? "bg-[#CC0000] text-white" : "bg-red-100 text-red-700"}`}>
                                  {activity.label === "Low" ? "Needs help" : "Review"}
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-gray-500">{hasPerformanceData ? snapshot?.region ?? "Region unavailable" : "Performance pending"}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-4 text-right">
                        <p className="font-black text-gray-950">{closed === null ? "--" : formatCurrency(closed)}</p>
                        <p className="text-xs text-gray-500">{closedDeals === null ? "pending" : `${closedDeals} won`}</p>
                      </td>
                      <td className="px-4 py-4 text-right">
                        <p className="font-black text-gray-950">{formatCurrency(rep.pipelineValue)}</p>
                        <p className="text-xs text-gray-500">{rep.activeDeals} deals</p>
                      </td>
                      <td className="px-4 py-4">
                        <DistributionBar row={funnelByRep.get(rep.repId)} />
                      </td>
                      <td className="px-4 py-4 text-right">
                        <p className="font-black text-gray-950">{winRate === null ? "--" : formatPercent(winRate)}</p>
                        {formatDelta(winDelta, "pp")}
                      </td>
                      <td className="px-4 py-4 text-center">
                        {atRisk > 0 ? (
                          <span className="rounded-full bg-red-100 px-2.5 py-1 text-xs font-black text-red-700">{atRisk}</span>
                        ) : (
                          <span className="text-gray-400">--</span>
                        )}
                      </td>
                      <td className="px-4 py-4">
                        <span className="inline-flex items-center gap-2 rounded-full bg-gray-100 px-2.5 py-1 text-xs font-bold text-gray-700">
                          <span className={`h-2 w-2 rounded-full ${activity.dot}`} />
                          {activity.label}
                        </span>
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex items-center justify-end gap-2">
                          <MiniSparkline values={snapshot?.sparkline8w ?? []} />
                          <Link
                            to={buildRepDetailPath(rep.repId, preset)}
                            aria-label={`Open ${rep.repName} breakdown`}
                            className="text-gray-300 opacity-0 transition-opacity group-hover:opacity-100"
                          >
                            <ChevronRight className="h-4 w-4" />
                          </Link>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <aside className="rounded-xl bg-gray-900 p-5 text-white shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-red-300" />
              <h2 className="text-xs font-black uppercase tracking-widest text-gray-300">Strategic Alerts</h2>
            </div>
            <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-black">{strategicAlerts.length}</span>
          </div>
          <div className="space-y-3">
            {strategicAlerts.length > 0 ? (
              strategicAlerts.map((alert) => (
                <div key={alert.id} className="rounded-lg bg-white/5 p-3">
                  <p className="text-sm font-bold leading-snug">{alert.title}</p>
                  <p className="mt-1 text-xs leading-5 text-gray-400">{alert.detail}</p>
                  <Link
                    to={alert.repId ? buildRepDetailPath(alert.repId, preset) : "/reports"}
                    className="mt-3 inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-wide text-red-300 hover:text-white"
                  >
                    {ActionIcon({ severity: alert.severity })} <ArrowUpRight className="h-3 w-3" />
                  </Link>
                </div>
              ))
            ) : (
              <p className="rounded-lg bg-white/5 p-3 text-sm text-gray-400">No strategic alerts are active.</p>
            )}
          </div>
        </aside>
      </section>
      ) : null}

      <section className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_390px]">
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-[#CC0000]" />
              <h2 className="text-sm font-black uppercase tracking-wide text-gray-950">At-risk deals</h2>
              <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-black text-red-700">{atRiskDeals.length}</span>
            </div>
            <Link to={atRiskDestination} className="text-xs font-bold uppercase tracking-wide text-[#CC0000] hover:text-red-700">
              Open all
            </Link>
          </div>

          <div className="divide-y divide-gray-100">
            {atRiskDeals.length > 0 ? (
              atRiskDeals.slice(0, 6).map((deal) => {
                const overSla = Math.max(0, deal.daysInStage - (deal.staleThresholdDays ?? deal.daysInStage));
                const repName = deal.repName;
                const workflowRoute = deal.workflowRoute ?? "normal";
                return (
                  <Link key={deal.dealId} to={`/deals/${deal.dealId}`} className="grid gap-3 px-5 py-4 transition-colors hover:bg-gray-50 md:grid-cols-[1fr_auto_auto_auto] md:items-center">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-900 text-[10px] font-black text-white">
                        {getInitials(repName)}
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-bold text-gray-950">{deal.dealName}</p>
                        <p className="text-xs text-gray-500">
                          {repName}
                          {deal.regionClassification ? ` · ${deal.regionClassification}` : ""}
                        </p>
                      </div>
                    </div>
                    <span className="w-fit rounded-full bg-gray-100 px-2.5 py-1 text-[10px] font-black uppercase tracking-wide text-gray-700">
                      {deal.stageName}
                    </span>
                    <div className="text-sm font-bold text-gray-950">{formatCurrency(deal.dealValue)}</div>
                    <div className="flex items-center justify-between gap-3 md:justify-end">
                      <span className={`${overSla > 0 ? "text-[#CC0000]" : "text-gray-500"} text-xs font-black`}>
                        {deal.daysInStage}d in stage
                      </span>
                      <span className="rounded-full bg-[#CC0000] px-2.5 py-1 text-[10px] font-black uppercase tracking-wide text-white">
                        {overSla > 0 ? `${overSla} days over SLA` : formatPathLabel(workflowRoute)}
                      </span>
                    </div>
                  </Link>
                );
              })
            ) : (
              <p className="px-5 py-8 text-center text-sm text-gray-400">No at-risk deals are currently flagged.</p>
            )}
          </div>
        </div>

        <aside className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-[#CC0000]" />
              <h2 className="text-xs font-black uppercase tracking-widest text-gray-500">AI Coaching</h2>
            </div>
            <span className="rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-black text-[#CC0000]">
              {aiPrompts.length} insights
            </span>
          </div>
          <div className="space-y-3">
            {aiPrompts.length > 0 ? (
              aiPrompts.slice(0, 5).map((prompt) => (
                <div key={prompt.id} className="rounded-lg border border-gray-100 p-3">
                  <div className="flex items-center gap-2">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#CC0000] text-[10px] font-black text-white">
                      {getInitials(prompt.repName)}
                    </div>
                    <p className="font-bold text-gray-950">{prompt.repName}</p>
                  </div>
                  <p className="mt-3 text-sm font-bold text-gray-900">{prompt.prompt}</p>
                  <p className="mt-1 text-xs leading-5 text-gray-500">{prompt.reason}</p>
                  <Link
                    to={buildRepDetailPath(prompt.repId, preset)}
                    className="mt-3 inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-wide text-[#CC0000] hover:text-red-700"
                  >
                    Schedule 1:1 <ArrowUpRight className="h-3 w-3" />
                  </Link>
                </div>
              ))
            ) : (
              <p className="rounded-lg border border-gray-100 p-3 text-sm text-gray-400">
                No coaching insights generated for this period.
              </p>
            )}
          </div>
        </aside>
      </section>

      <section className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_390px]">
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="mb-5 flex items-center justify-between">
            <h2 className="text-sm font-black uppercase tracking-wide text-gray-950">Activity pulse · {periodLabel}</h2>
            <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-black text-gray-700">{totalActivity} total</span>
          </div>
          <div className="space-y-4">
            {activityPulse.length > 0 ? (
              activityPulse.map((row) => {
                const max = Math.max(...activityPulse.map((item) => item.total), 1);
                const width = clampPercent((row.total / max) * 100);
                const callWidth = row.total > 0 ? (row.calls / row.total) * 100 : 0;
                const emailWidth = row.total > 0 ? (row.emails / row.total) * 100 : 0;
                const meetingWidth = row.total > 0 ? (row.meetings / row.total) * 100 : 0;
                return (
                  <div key={row.repId}>
                    <div className="mb-2 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-900 text-[10px] font-black text-white">
                          {getInitials(row.repName)}
                        </div>
                        <p className="font-bold text-gray-950">{row.repName}</p>
                      </div>
                      <p className="font-black text-gray-950">{row.total}</p>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-gray-100">
                      <div className="flex h-full" style={{ width: `${width}%` }}>
                        <div className="bg-emerald-500" style={{ width: `${callWidth}%` }} />
                        <div className="bg-blue-500" style={{ width: `${emailWidth}%` }} />
                        <div className="bg-purple-500" style={{ width: `${meetingWidth}%` }} />
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-3 text-[10px] font-bold uppercase tracking-wide text-gray-500">
                      <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3 text-emerald-500" />{row.calls} calls</span>
                      <span className="inline-flex items-center gap-1"><Mail className="h-3 w-3 text-blue-500" />{row.emails} emails</span>
                      <span className="inline-flex items-center gap-1"><CalendarClock className="h-3 w-3 text-purple-500" />{row.meetings} meetings</span>
                    </div>
                  </div>
                );
              })
            ) : (
              <p className="text-sm text-gray-400">No activity pulse data for {periodLabel.toLowerCase()}.</p>
            )}
          </div>
        </div>

        <aside className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Trophy className="h-4 w-4 text-[#CC0000]" />
              <h2 className="text-xs font-black uppercase tracking-widest text-gray-500">Recent closes</h2>
            </div>
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-black text-gray-700">
              {wonCloses} won · {lostCloses} lost
            </span>
          </div>
          <div className="space-y-3">
            {recentCloses.length > 0 ? (
              recentCloses.slice(0, 6).map((close) => {
                const Icon = close.outcome === "won" ? CheckCircle2 : XCircle;
                const color = close.outcome === "won" ? "text-emerald-600" : "text-[#CC0000]";
                return (
                  <Link key={close.dealId} to={`/deals/${close.dealId}`} className="grid grid-cols-[24px_1fr_auto] gap-3 rounded-lg border border-gray-100 p-3 hover:bg-gray-50">
                    <Icon className={`mt-0.5 h-4 w-4 ${color}`} />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold text-gray-950">{close.dealName}</p>
                      <p className="text-xs text-gray-500">{close.repName}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-black text-gray-950">{formatCurrency(close.dealValue)}</p>
                      <p className="text-xs text-gray-500">{relativeDate(close.closedAt)}</p>
                    </div>
                  </Link>
                );
              })
            ) : (
              <p className="rounded-lg border border-gray-100 p-3 text-sm text-gray-400">No recent won or lost deals in this range.</p>
            )}
          </div>
        </aside>
      </section>
    </div>
  );
}
