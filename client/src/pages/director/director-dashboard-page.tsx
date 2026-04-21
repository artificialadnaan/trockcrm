import { useState } from "react";
import {
  presetToDateRange,
  useDirectorDashboard,
  type DateRangePreset,
} from "@/hooks/use-director-dashboard";
import { useRepPerformance } from "@/hooks/use-rep-performance";
import { DirectorBlindSpotList } from "@/components/ai/director-blind-spot-list";
import { PipelineBarChart } from "@/components/charts/pipeline-bar-chart";
import { WinRateTrendChart } from "@/components/charts/win-rate-trend-chart";
import { formatCurrency } from "@/components/charts/chart-colors";
import { DashboardKpiBand } from "@/components/dashboard/dashboard-kpi-band";
import { DirectorActivitySummary } from "@/components/dashboard/director-activity-summary";
import { DirectorAlertPanel } from "@/components/dashboard/director-alert-panel";
import { DirectorRepWorkspace } from "@/components/dashboard/director-rep-workspace";
import { DIRECTOR_DASHBOARD_ACTIONS } from "@/lib/director-dashboard-actions";

const PRESETS: Array<{ value: DateRangePreset; label: string }> = [
  { value: "mtd", label: "MTD" },
  { value: "qtd", label: "QTD" },
  { value: "ytd", label: "YTD" },
  { value: "last_month", label: "Last Month" },
  { value: "last_quarter", label: "Last Quarter" },
  { value: "last_year", label: "Last Year" },
];

const PERF_PERIODS = [
  { value: "month" as const, label: "Month" },
  { value: "quarter" as const, label: "Quarter" },
  { value: "year" as const, label: "Year" },
];

function visit(to: string) {
  if (typeof window !== "undefined") {
    window.location.assign(to);
  }
}

function DeltaCell({
  value,
  format = "number",
}: {
  value: number;
  format?: "number" | "currency" | "percent" | "days";
}) {
  if (value === 0) {
    return (
      <span className="text-xs text-gray-400">
        {format === "currency" ? "$0" : format === "percent" ? "0%" : format === "days" ? "0d" : "0"}
      </span>
    );
  }

  const isPositiveGood = format !== "days";
  const isGood = isPositiveGood ? value > 0 : value < 0;
  const colorClass = isGood ? "text-emerald-600" : "text-rose-500";
  const prefix = value > 0 ? "+" : "";

  if (format === "currency") {
    return <span className={`text-xs font-semibold ${colorClass}`}>{prefix}{formatCurrency(value)}</span>;
  }

  if (format === "percent") {
    return <span className={`text-xs font-semibold ${colorClass}`}>{prefix}{value}%</span>;
  }

  if (format === "days") {
    return <span className={`text-xs font-semibold ${colorClass}`}>{prefix}{value}d</span>;
  }

  return <span className={`text-xs font-semibold ${colorClass}`}>{prefix}{value}</span>;
}

export function DirectorDashboardPage() {
  const [preset, setPreset] = useState<DateRangePreset>("ytd");
  const [perfPeriod, setPerfPeriod] = useState<"month" | "quarter" | "year">("month");
  const dateRange = presetToDateRange(preset);
  const { data, loading, error } = useDirectorDashboard(dateRange);
  const { data: perfData, loading: perfLoading } = useRepPerformance(perfPeriod);

  if (loading) {
    return (
      <div className="min-h-screen space-y-6 bg-gray-50 p-6">
        <div className="space-y-2">
          <div className="h-8 w-64 animate-pulse rounded bg-gray-200" />
          <div className="h-4 w-80 animate-pulse rounded bg-gray-100" />
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="h-28 animate-pulse rounded-2xl bg-white" />
          ))}
        </div>
        <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
          <div className="h-96 animate-pulse rounded-2xl bg-white" />
          <div className="space-y-4">
            <div className="h-48 animate-pulse rounded-2xl bg-white" />
            <div className="h-48 animate-pulse rounded-2xl bg-white" />
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen space-y-4 bg-gray-50 p-6">
        <h1 className="text-3xl font-black tracking-tight text-gray-900">Director Dashboard</h1>
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-6 text-sm text-rose-700">
          {error}
        </div>
      </div>
    );
  }

  if (!data) {
    return null;
  }

  const kpis = [
    {
      label: "True pipeline",
      value: formatCurrency(data.ddVsPipeline.pipelineValue),
      detail: `${data.ddVsPipeline.pipelineCount} active deals`,
    },
    {
      label: "DD pipeline",
      value: formatCurrency(data.ddVsPipeline.ddValue),
      detail: `${data.ddVsPipeline.ddCount} deals in due diligence`,
    },
    {
      label: "Total pipeline",
      value: formatCurrency(data.ddVsPipeline.totalValue),
      detail: `${data.ddVsPipeline.totalCount} deals total`,
    },
    {
      label: "Stale deals",
      value: String(data.staleDeals.length),
      detail: `${data.staleLeads.length} stale leads`,
      tone: data.staleDeals.length > 0 ? "warning" : "default",
    },
  ] as const;

  return (
    <div className="min-h-screen space-y-6 bg-gray-50 p-6">
      <header className="flex flex-col gap-4 rounded-3xl border border-gray-200 bg-white p-6 shadow-sm xl:flex-row xl:items-start xl:justify-between">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-gray-400">
            Director workspace
          </p>
          <div>
            <h1 className="text-3xl font-black tracking-tight text-gray-900">Director Dashboard</h1>
            <p className="mt-2 max-w-2xl text-sm text-gray-500">
              Monitor pipeline health, rep execution, and stale work from a single operating view.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-3 xl:items-end">
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setPreset(option.value)}
                className={`rounded-full px-4 py-2 text-xs font-semibold uppercase tracking-wide transition ${
                  preset === option.value
                    ? "bg-gray-900 text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200 hover:text-gray-900"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            {DIRECTOR_DASHBOARD_ACTIONS.map((action) => (
              <a
                key={action.key}
                href={action.to}
                title={action.title}
                className="inline-flex items-center rounded-full border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-700 transition hover:border-gray-300 hover:text-gray-900"
              >
                {action.label}
              </a>
            ))}
          </div>
        </div>
      </header>

      <DashboardKpiBand items={kpis} />

      <section className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <DirectorRepWorkspace repCards={data.repCards} onSelectRep={(repId) => visit(`/director/rep/${repId}`)} />

        <div className="space-y-4">
          <DirectorActivitySummary rows={data.activityByRep} />
          <DirectorAlertPanel staleDeals={data.staleDeals} staleLeads={data.staleLeads} />
          <DirectorBlindSpotList />
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-2xl border border-gray-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
            <div>
              <h2 className="text-sm font-bold uppercase tracking-wide text-gray-900">Pipeline by stage</h2>
              <p className="mt-1 text-sm text-gray-500">Stage concentration across the selected date range.</p>
            </div>
            <a href="/pipeline" className="text-sm font-semibold text-gray-500 hover:text-gray-900">
              Open pipeline
            </a>
          </div>
          <div className="p-4">
            {data.pipelineByStage.length > 0 ? (
              <PipelineBarChart data={data.pipelineByStage} />
            ) : (
              <p className="py-8 text-center text-sm text-gray-400">No pipeline data.</p>
            )}
          </div>
        </section>

        <section className="rounded-2xl border border-gray-200 bg-white shadow-sm">
          <div className="border-b border-gray-100 px-5 py-4">
            <h2 className="text-sm font-bold uppercase tracking-wide text-gray-900">Win rate trend</h2>
            <p className="mt-1 text-sm text-gray-500">Monthly close performance over time.</p>
          </div>
          <div className="p-4">
            {data.winRateTrend.length > 0 ? (
              <WinRateTrendChart data={data.winRateTrend} />
            ) : (
              <p className="py-8 text-center text-sm text-gray-400">No closed deals yet.</p>
            )}
          </div>
        </section>
      </section>

      <section className="rounded-2xl border border-gray-200 bg-white shadow-sm">
        <div className="flex flex-col gap-3 border-b border-gray-100 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-sm font-bold uppercase tracking-wide text-gray-900">Performance trends</h2>
            <p className="mt-1 text-sm text-gray-500">
              Current-period rep outcomes compared against the prior period.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            {PERF_PERIODS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setPerfPeriod(option.value)}
                className={`rounded-full px-4 py-2 text-xs font-semibold uppercase tracking-wide transition ${
                  perfPeriod === option.value
                    ? "bg-gray-900 text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200 hover:text-gray-900"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {perfLoading ? (
          <div className="p-8 text-center">
            <div className="mx-auto h-4 w-48 animate-pulse rounded bg-gray-100" />
          </div>
        ) : !perfData || perfData.reps.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-400">No performance data for this period.</div>
        ) : (
          <>
            <div className="border-b border-gray-100 bg-gray-50 px-5 py-2">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-gray-400">
                {perfData.periodLabel.current} vs {perfData.periodLabel.previous}
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full">
                <thead>
                  <tr className="text-left text-[11px] font-semibold uppercase tracking-widest text-gray-400">
                    <th className="px-5 py-3">Rep</th>
                    <th className="px-3 py-3 text-right">Deals won</th>
                    <th className="px-3 py-3 text-right">Value won</th>
                    <th className="px-3 py-3 text-right">Win rate</th>
                    <th className="px-3 py-3 text-right">Activities</th>
                    <th className="px-5 py-3 text-right">Avg close</th>
                  </tr>
                </thead>
                <tbody>
                  {perfData.reps.map((rep) => (
                    <tr key={rep.repId} className="border-t border-gray-100">
                      <td className="px-5 py-3 text-sm font-semibold text-gray-900">{rep.repName}</td>
                      <td className="px-3 py-3 text-right">
                        <div className="flex flex-col items-end gap-0.5">
                          <span className="text-sm text-gray-700">{rep.current.dealsWon}</span>
                          <DeltaCell value={rep.change.dealsWon} />
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right">
                        <div className="flex flex-col items-end gap-0.5">
                          <span className="text-sm font-semibold text-gray-900">
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
      </section>
    </div>
  );
}
