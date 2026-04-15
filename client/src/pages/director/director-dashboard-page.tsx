import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import {
  useDirectorDashboard,
  presetToDateRange,
  type DateRangePreset,
} from "@/hooks/use-director-dashboard";
import { useRepPerformance } from "@/hooks/use-rep-performance";
import { PipelineBarChart } from "@/components/charts/pipeline-bar-chart";
import { WinRateTrendChart } from "@/components/charts/win-rate-trend-chart";
import { ActivityBarChart } from "@/components/charts/activity-bar-chart";
import { formatCurrency } from "@/components/charts/chart-colors";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  BarChart3,
  TrendingUp,
  Building2,
  Activity,
  ChevronRight,
  AlertTriangle,
  Bell,
  User,
  MapPin,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
} from "lucide-react";
import { DIRECTOR_DASHBOARD_ACTIONS } from "@/lib/director-dashboard-actions";
import { buildStaleLeadAlertSummary } from "@/lib/stale-lead-dashboard";

const PRESETS: Array<{ value: DateRangePreset; label: string }> = [
  { value: "mtd", label: "MTD" },
  { value: "qtd", label: "QTD" },
  { value: "ytd", label: "YTD" },
  { value: "last_month", label: "Last Month" },
  { value: "last_quarter", label: "Last Quarter" },
  { value: "last_year", label: "Last Year" },
];

function getActivityLevel(score: number): { dot: string; label: string } {
  if (score >= 70) return { dot: "bg-green-500", label: "High" };
  if (score >= 40) return { dot: "bg-yellow-400", label: "Moderate" };
  return { dot: "bg-red-500", label: "Review" };
}

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

const PERF_PERIODS = [
  { value: "month" as const, label: "Month" },
  { value: "quarter" as const, label: "Quarter" },
  { value: "year" as const, label: "Year" },
];

function DeltaCell({ value, format = "number" }: { value: number; format?: "number" | "currency" | "percent" | "days" }) {
  if (value === 0) {
    return (
      <span className="inline-flex items-center gap-0.5 text-xs text-gray-400">
        <Minus className="h-3 w-3" />
        {format === "currency" ? "$0" : format === "percent" ? "0%" : "0"}
      </span>
    );
  }

  // For avgDaysToClose, lower is better (negative = improvement)
  const isPositiveGood = format !== "days";
  const isGood = isPositiveGood ? value > 0 : value < 0;

  const colorClass = isGood ? "text-green-600" : "text-red-500";
  const Icon = value > 0 ? ArrowUpRight : ArrowDownRight;
  const prefix = value > 0 ? "+" : "";

  let display: string;
  if (format === "currency") {
    const abs = Math.abs(value);
    display = `${prefix}${abs >= 1000 ? `$${(value / 1000).toFixed(1)}K` : `$${value.toLocaleString()}`}`;
  } else if (format === "percent") {
    display = `${prefix}${value}%`;
  } else if (format === "days") {
    display = `${prefix}${value}d`;
  } else {
    display = `${prefix}${value}`;
  }

  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-semibold ${colorClass}`}>
      <Icon className="h-3 w-3" />
      {display}
    </span>
  );
}

export function DirectorDashboardPage() {
  const navigate = useNavigate();
  const [preset, setPreset] = useState<DateRangePreset>("ytd");
  const [perfPeriod, setPerfPeriod] = useState<"month" | "quarter" | "year">("month");
  const dateRange = presetToDateRange(preset);
  const { data, loading, error } = useDirectorDashboard(dateRange);
  const { data: perfData, loading: perfLoading } = useRepPerformance(perfPeriod);

  if (loading) {
    return (
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <div className="h-8 w-64 bg-gray-200 rounded animate-pulse" />
            <div className="h-3 w-48 bg-gray-100 rounded animate-pulse mt-2" />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-40 bg-gray-100 rounded-xl animate-pulse" />
          ))}
        </div>
        <div className="h-72 bg-gray-100 rounded-xl animate-pulse" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 space-y-4">
        <h2 className="text-3xl font-black tracking-tighter uppercase">Director Dashboard</h2>
        <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-center text-red-600">
          {error}
        </div>
      </div>
    );
  }

  if (!data) return null;

  const firstStaleAlert = data.staleDeals[0] ?? null;
  const staleLeadAlert = buildStaleLeadAlertSummary(
    data.staleLeads[0],
    "Lead pipeline on track",
    "No current stale leads detected today"
  );

  return (
    <div className="p-6 space-y-6 bg-gray-50 min-h-screen">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-black tracking-tighter uppercase text-gray-900">
            Director Dashboard
          </h1>
          <p className="text-[11px] uppercase tracking-widest text-gray-400 mt-0.5">
            Strategic Performance Overview
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Date range pill */}
          <div className="flex items-center gap-1 bg-gray-200 rounded-full px-1.5 py-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.value}
                onClick={() => setPreset(p.value)}
                className={`px-3 py-1 rounded-full text-xs font-semibold transition-all ${
                  preset === p.value
                    ? "bg-[#CC0000] text-white shadow-sm"
                    : "text-gray-600 hover:text-gray-900"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Action buttons */}
          {DIRECTOR_DASHBOARD_ACTIONS.map((action) => {
            const Icon = action.key === "alerts" ? Bell : BarChart3;
            return (
              <button
                key={action.key}
                type="button"
                aria-label={action.label}
                title={action.title}
                onClick={() => navigate(action.to)}
                className="w-8 h-8 rounded-full bg-white border border-gray-200 flex items-center justify-center text-gray-500 hover:text-gray-800 transition-colors shadow-sm"
              >
                <Icon className="h-4 w-4" />
              </button>
            );
          })}
          <div className="w-8 h-8 rounded-full bg-[#CC0000] flex items-center justify-center text-white text-xs font-bold shadow-sm">
            <User className="h-4 w-4" />
          </div>
        </div>
      </div>

      {/* ── Metric Cards (Bento 3-col) ──────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* True Pipeline */}
        <div
          className="group relative bg-white rounded-xl border border-gray-200 border-b-4 border-b-red-200 hover:border-b-[#CC0000] shadow-sm p-5 cursor-pointer transition-all overflow-hidden"
          onClick={() => navigate("/pipeline")}
        >
          <div className="absolute top-3 right-3 opacity-0 group-hover:opacity-10 transition-opacity">
            <BarChart3 className="h-16 w-16 text-gray-800" />
          </div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-3">
            True Pipeline
          </p>
          <p className="text-5xl font-black text-gray-900 leading-none">
            {formatCurrency(data.ddVsPipeline.pipelineValue)}
          </p>
          <div className="flex items-center gap-2 mt-3">
            <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-green-100 text-green-700 text-[10px] font-bold uppercase tracking-wide">
              {data.ddVsPipeline.pipelineCount} DEALS
            </span>
            <span className="text-[10px] text-gray-400 uppercase tracking-wide">Active Forecast</span>
          </div>
        </div>

        {/* DD Pipeline */}
        <div
          className="group relative bg-white rounded-xl border border-gray-200 border-b-4 border-b-blue-200 hover:border-b-blue-600 shadow-sm p-5 cursor-pointer transition-all overflow-hidden"
          onClick={() => navigate("/deals?stage=dd")}
        >
          <div className="absolute top-3 right-3 opacity-0 group-hover:opacity-10 transition-opacity">
            <TrendingUp className="h-16 w-16 text-gray-800" />
          </div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-3">
            DD Pipeline
          </p>
          <p className="text-5xl font-black text-gray-900 leading-none">
            {formatCurrency(data.ddVsPipeline.ddValue)}
          </p>
          <div className="flex items-center gap-2 mt-3">
            <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 text-[10px] font-bold uppercase tracking-wide">
              {data.ddVsPipeline.ddCount} DEALS
            </span>
            <span className="text-[10px] text-gray-400 uppercase tracking-wide">Due Diligence Phase</span>
          </div>
        </div>

        {/* Total Pipeline — red gradient */}
        <div
          className="relative rounded-xl p-5 cursor-pointer transition-all overflow-hidden shadow-sm"
          style={{ background: "linear-gradient(135deg, #CC0000 0%, #991111 100%)" }}
          onClick={() => navigate("/deals")}
        >
          <div className="absolute top-3 right-3 opacity-10">
            <Building2 className="h-16 w-16 text-white" />
          </div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-red-200 mb-3">
            Total Pipeline
          </p>
          <p className="text-5xl font-black text-white leading-none">
            {formatCurrency(data.ddVsPipeline.totalValue)}
          </p>
          <div className="flex items-center gap-2 mt-3">
            <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-white/20 text-white text-[10px] font-bold uppercase tracking-wide">
              {data.ddVsPipeline.totalCount} DEALS TOTAL
            </span>
          </div>
        </div>
      </div>

      {/* ── Main Content: Table + Sidebar ───────────────────────────────── */}
      <div className="grid grid-cols-12 gap-4">
        {/* Sales Force Performance Table (8 cols) */}
        <div className="col-span-12 lg:col-span-8">
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h2 className="text-sm font-bold text-gray-900 uppercase tracking-wide">
                Sales Force Performance
              </h2>
              <Link
                to="/reports"
                className="text-xs font-semibold text-[#CC0000] hover:text-red-700 flex items-center gap-1 transition-colors"
              >
                Full Report
                <ChevronRight className="h-3 w-3" />
              </Link>
            </div>

            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-100">
                  <th className="text-left px-5 py-2.5 text-[10px] font-bold uppercase tracking-widest text-gray-500">
                    Representative
                  </th>
                  <th className="text-right px-4 py-2.5 text-[10px] font-bold uppercase tracking-widest text-gray-500">
                    Active Deals
                  </th>
                  <th className="text-right px-4 py-2.5 text-[10px] font-bold uppercase tracking-widest text-gray-500">
                    Pipeline Value
                  </th>
                  <th className="text-right px-4 py-2.5 text-[10px] font-bold uppercase tracking-widest text-gray-500">
                    Win Rate
                  </th>
                  <th className="text-right px-5 py-2.5 text-[10px] font-bold uppercase tracking-widest text-gray-500">
                    Activity
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.repCards.length === 0 && (
                  <tr>
                    <td colSpan={5} className="text-center py-8 text-gray-400 text-sm">
                      No active reps found.
                    </td>
                  </tr>
                )}
                {data.repCards.map((rep) => {
                  const activity = getActivityLevel(rep.activityScore);
                  return (
                    <tr
                      key={rep.repId}
                      className="border-t border-gray-50 hover:bg-gray-50 transition-colors cursor-pointer"
                      onClick={() => navigate(`/director/rep/${rep.repId}`)}
                    >
                      {/* Representative */}
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-[#CC0000] flex items-center justify-center text-white text-[11px] font-bold flex-shrink-0">
                            {getInitials(rep.repName)}
                          </div>
                          <div>
                            <p className="text-sm font-semibold text-gray-900 leading-tight">
                              {rep.repName}
                            </p>
                            <p className="text-[10px] text-gray-400 uppercase tracking-wide">
                              Sales Rep
                            </p>
                          </div>
                        </div>
                      </td>

                      {/* Active Deals */}
                      <td className="px-4 py-3 text-right font-mono text-sm font-semibold text-gray-700">
                        {rep.activeDeals}
                      </td>

                      {/* Pipeline Value */}
                      <td className="px-4 py-3 text-right text-sm font-bold text-gray-900">
                        {formatCurrency(rep.pipelineValue)}
                      </td>

                      {/* Win Rate */}
                      <td className="px-4 py-3 text-right">
                        <div className="flex flex-col items-end gap-1">
                          <div className="w-20 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-[#CC0000] rounded-full"
                              style={{ width: `${Math.min(rep.winRate, 100)}%` }}
                            />
                          </div>
                          <span className="text-xs text-gray-600">{rep.winRate}%</span>
                        </div>
                      </td>

                      {/* Activity */}
                      <td className="px-5 py-3 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <span className={`w-2 h-2 rounded-full ${activity.dot}`} />
                          <span className="text-xs text-gray-600">{activity.label}</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Strategic Insights Sidebar (4 cols) */}
        <div className="col-span-12 lg:col-span-4 space-y-4">
          {/* Strategic Alert Card */}
          <div className="relative bg-gray-800 rounded-xl p-5 overflow-hidden">
            {/* Decorative bg icon */}
            <div className="absolute top-3 right-3 opacity-5">
              <Activity className="h-24 w-24 text-white" />
            </div>

            <div className="flex items-center gap-2 mb-4">
              <AlertTriangle className="h-4 w-4 text-amber-400" />
              <h3 className="text-xs font-bold uppercase tracking-widest text-gray-300">
                Strategic Alerts
              </h3>
            </div>

            <div className="space-y-3">
              {/* Alert 1 — red: stale deal or pipeline warning */}
              <div className="border-l-4 border-[#CC0000] pl-3 py-1">
                {firstStaleAlert ? (
                  <>
                    <p className="text-xs font-semibold text-white leading-snug">
                      {firstStaleAlert.dealName}
                    </p>
                    <p className="text-[10px] text-gray-400 mt-0.5">
                      {firstStaleAlert.daysInStage}d stale &mdash; {firstStaleAlert.repName} &mdash;{" "}
                      {firstStaleAlert.stageName}
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-xs font-semibold text-white leading-snug">
                      Pipeline on track
                    </p>
                    <p className="text-[10px] text-gray-400 mt-0.5">
                      No stale deals detected this period
                    </p>
                  </>
                )}
              </div>

              {/* Alert 2 — blue: velocity / performance insight */}
              <div className="border-l-4 border-blue-400 pl-3 py-1">
                {data.staleLeads[0] ? (
                  <>
                    <p className="text-xs font-semibold text-white leading-snug">
                      {staleLeadAlert.title}
                    </p>
                    <p className="text-[10px] text-gray-400 mt-0.5">
                      {staleLeadAlert.detail}
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-xs font-semibold text-white leading-snug">
                      {staleLeadAlert.title}
                    </p>
                    <p className="text-[10px] text-gray-400 mt-0.5">
                      {staleLeadAlert.detail}
                    </p>
                  </>
                )}
              </div>
            </div>

            {(data.staleDeals.length > 0 || data.staleLeads.length > 0) && (
              <div className="mt-4 space-y-1">
                {data.staleDeals.length > 0 && (
                  <Link
                    to="/deals?filter=stale"
                    className="flex items-center gap-1 text-[10px] font-semibold text-gray-400 hover:text-white transition-colors"
                  >
                    View all {data.staleDeals.length} stale deals
                    <ChevronRight className="h-3 w-3" />
                  </Link>
                )}
                {data.staleLeads.length > 0 && (
                  <Link
                    to="/reports"
                    className="flex items-center gap-1 text-[10px] font-semibold text-gray-400 hover:text-white transition-colors"
                  >
                    Review {data.staleLeads.length} current stale leads
                    <ChevronRight className="h-3 w-3" />
                  </Link>
                )}
              </div>
            )}
          </div>

          {/* Regional Focus Card */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xs font-bold uppercase tracking-widest text-gray-500">
                Regional Focus
              </h3>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 text-[10px] font-semibold text-gray-600">
                <MapPin className="h-2.5 w-2.5" />
                Texas/S.W. Zone
              </span>
            </div>

            {/* Map placeholder */}
            <div className="relative w-full h-32 bg-gray-100 rounded-lg overflow-hidden flex items-center justify-center">
              <div className="absolute inset-0 opacity-20">
                {/* subtle grid pattern */}
                <div
                  className="w-full h-full"
                  style={{
                    backgroundImage:
                      "linear-gradient(to right, #CBD5E1 1px, transparent 1px), linear-gradient(to bottom, #CBD5E1 1px, transparent 1px)",
                    backgroundSize: "16px 16px",
                  }}
                />
              </div>
              <div className="relative z-10 px-3 py-1.5 rounded-full bg-[#CC0000] text-white text-[11px] font-bold shadow-md">
                {formatCurrency(data.ddVsPipeline.totalValue)} Active Ops
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Charts Row (Pipeline by Stage + Win Rate Trend) ─────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div
          className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden cursor-pointer hover:shadow-md transition-shadow"
          onClick={() => navigate("/pipeline")}
        >
          <div className="px-5 py-4 border-b border-gray-100">
            <h3 className="text-sm font-bold text-gray-900 uppercase tracking-wide">
              Pipeline by Stage
            </h3>
          </div>
          <div className="p-4">
            {data.pipelineByStage.length > 0 ? (
              <PipelineBarChart data={data.pipelineByStage} />
            ) : (
              <p className="text-gray-400 text-sm text-center py-8">No pipeline data.</p>
            )}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100">
            <h3 className="text-sm font-bold text-gray-900 uppercase tracking-wide">
              Win Rate Trend
            </h3>
          </div>
          <div className="p-4">
            {data.winRateTrend.length > 0 ? (
              <WinRateTrendChart data={data.winRateTrend} />
            ) : (
              <p className="text-gray-400 text-sm text-center py-8">No closed deals yet.</p>
            )}
          </div>
        </div>
      </div>

      {/* ── Performance Trends (MoM / QoQ / YoY) ──────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h3 className="text-sm font-bold text-gray-900 uppercase tracking-wide">
            Performance Trends
          </h3>
          <div className="flex items-center gap-1 bg-gray-200 rounded-full px-1.5 py-1">
            {PERF_PERIODS.map((p) => (
              <button
                key={p.value}
                onClick={() => setPerfPeriod(p.value)}
                className={`px-3 py-1 rounded-full text-xs font-semibold transition-all ${
                  perfPeriod === p.value
                    ? "bg-[#CC0000] text-white shadow-sm"
                    : "text-gray-600 hover:text-gray-900"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {perfLoading ? (
          <div className="p-8 text-center">
            <div className="h-4 w-48 bg-gray-100 rounded animate-pulse mx-auto" />
          </div>
        ) : !perfData || perfData.reps.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">
            No performance data for this period.
          </div>
        ) : (
          <>
            <div className="px-5 py-2 bg-gray-50 border-b border-gray-100">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">
                {perfData.periodLabel.current} vs {perfData.periodLabel.previous}
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-100">
                    <th className="text-left px-5 py-2.5 text-[10px] font-bold uppercase tracking-widest text-gray-500">
                      Rep
                    </th>
                    <th className="text-right px-3 py-2.5 text-[10px] font-bold uppercase tracking-widest text-gray-500">
                      Deals Won
                    </th>
                    <th className="text-right px-3 py-2.5 text-[10px] font-bold uppercase tracking-widest text-gray-500">
                      Value Won
                    </th>
                    <th className="text-right px-3 py-2.5 text-[10px] font-bold uppercase tracking-widest text-gray-500">
                      Win Rate
                    </th>
                    <th className="text-right px-3 py-2.5 text-[10px] font-bold uppercase tracking-widest text-gray-500">
                      Activities
                    </th>
                    <th className="text-right px-5 py-2.5 text-[10px] font-bold uppercase tracking-widest text-gray-500">
                      Avg Close
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {perfData.reps.map((rep) => (
                    <tr
                      key={rep.repId}
                      className="border-t border-gray-50 hover:bg-gray-50 transition-colors"
                    >
                      <td className="px-5 py-3">
                        <p className="text-sm font-semibold text-gray-900">{rep.repName}</p>
                      </td>
                      <td className="px-3 py-3 text-right">
                        <div className="flex flex-col items-end gap-0.5">
                          <span className="text-sm font-semibold text-gray-700">{rep.current.dealsWon}</span>
                          <DeltaCell value={rep.change.dealsWon} />
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right">
                        <div className="flex flex-col items-end gap-0.5">
                          <span className="text-sm font-bold text-gray-900">
                            {formatCurrency(rep.current.totalWonValue)}
                          </span>
                          <DeltaCell value={rep.change.totalWonValue} format="currency" />
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right">
                        <div className="flex flex-col items-end gap-0.5">
                          <span className="text-sm text-gray-700">{rep.current.winRate}%</span>
                          <DeltaCell value={rep.change.winRate} format="percent" />
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right">
                        <div className="flex flex-col items-end gap-0.5">
                          <span className="text-sm text-gray-700">{rep.current.activitiesLogged}</span>
                          <DeltaCell value={rep.change.activitiesLogged} />
                        </div>
                      </td>
                      <td className="px-5 py-3 text-right">
                        <div className="flex flex-col items-end gap-0.5">
                          <span className="text-sm text-gray-700">{rep.current.avgDaysToClose}d</span>
                          <DeltaCell value={rep.change.avgDaysToClose} format="days" />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* ── Activity by Rep ─────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <h3 className="text-sm font-bold text-gray-900 uppercase tracking-wide">
            Activity by Rep
          </h3>
        </div>
        <div className="p-4">
          {data.activityByRep.length > 0 ? (
            <ActivityBarChart data={data.activityByRep} />
          ) : (
            <p className="text-gray-400 text-sm text-center py-8">No activity data.</p>
          )}
        </div>
      </div>
    </div>
  );
}
