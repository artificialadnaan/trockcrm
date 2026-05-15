import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import { useReportFilters } from "@/components/reports/report-filter-bar";
import { useExecutiveTrendsReport } from "@/hooks/use-reports";
import { sheetsFromReport } from "@/lib/excel-export";
import {
  EmptyState,
  formatCurrency,
  formatNumber,
  formatPercent,
  ReportPageShell,
  TrendIcon,
} from "./analytics-page-shared";

export function ExecutiveTrendsPage() {
  const { query } = useReportFilters({ defaultRange: "12m" });
  const { data, loading, error, refetch } = useExecutiveTrendsReport(query);
  const report = data;

  return (
    <ReportPageShell
      title="Executive Trends"
      description="Multi-period operating indicators for pipeline, wins, losses, and stage progression."
      loading={loading}
      error={error}
      onRefresh={() => void refetch()}
      exportFilename="executive-trends-report"
      exportSheets={sheetsFromReport("Executive Trends", report)}
    >
      {report ? (
        <div className="space-y-6">
          <section className="grid gap-4 md:grid-cols-4">
            {report.kpis.map((kpi) => (
              <Card key={kpi.label}>
                <CardContent className="p-5">
                  <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">{kpi.label}</p>
                  <div className="mt-2 text-2xl font-black tracking-tight text-slate-950">{formatKpiValue(kpi.value, kpi.format)}</div>
                  <div className="mt-2 flex items-center gap-1 text-xs font-bold text-slate-600">
                    <TrendIcon direction={kpi.direction} />
                    <span>{formatPercent(Math.abs(kpi.changePercent))} vs previous period</span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </section>

          <Card>
            <CardContent className="p-5">
              <h2 className="text-sm font-black uppercase tracking-[0.16em] text-slate-900">Monthly Operating Trends</h2>
              <p className="mt-1 text-xs font-semibold text-slate-500">{report.activePipelineNote}</p>
              {report.monthlyTrends.length ? (
                <div className="mt-4 h-80">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={report.monthlyTrends}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="month" />
                      <YAxis yAxisId="count" allowDecimals={false} />
                      <YAxis yAxisId="value" orientation="right" tickFormatter={(value) => `$${Number(value) / 1000}k`} />
                      <Tooltip formatter={(value, name) => [name === "Active pipeline" ? formatCurrency(Number(value)) : formatNumber(Number(value)), name]} />
                      <Legend />
                      <Line yAxisId="count" type="monotone" dataKey="newDeals" name="New deals" stroke="#2563eb" strokeWidth={2} />
                      <Line yAxisId="count" type="monotone" dataKey="wonDeals" name="Won" stroke="#16a34a" strokeWidth={2} />
                      <Line yAxisId="count" type="monotone" dataKey="lostDeals" name="Lost" stroke="#cc0000" strokeWidth={2} />
                      <Line yAxisId="value" type="monotone" dataKey="activePipelineValue" name="Active pipeline" stroke="#111827" strokeWidth={2} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              ) : <EmptyState label="No monthly trend data for this range." />}
            </CardContent>
          </Card>

          <section className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardContent className="p-5">
                <h2 className="text-sm font-black uppercase tracking-[0.16em] text-slate-900">Win Rate Trend</h2>
                {report.winRateTrend.length ? (
                  <div className="mt-4 h-72">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={report.winRateTrend}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="month" />
                        <YAxis tickFormatter={(value) => `${value}%`} />
                        <Tooltip formatter={(value) => formatPercent(Number(value))} />
                        <Line type="monotone" dataKey="winRate" name="Win rate" stroke="#cc0000" strokeWidth={2} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                ) : <EmptyState label="No win-rate data." />}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-5">
                <h2 className="text-sm font-black uppercase tracking-[0.16em] text-slate-900">Stage Progression Rates</h2>
                {report.stageProgression.length ? (
                  <>
                    <div className="mt-4 h-72">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={report.stageProgression}>
                          <CartesianGrid strokeDasharray="3 3" />
                          <XAxis dataKey="stageName" />
                          <YAxis tickFormatter={(value) => `${value}%`} />
                          <Tooltip formatter={(value) => formatPercent(Number(value))} />
                          <Bar dataKey="progressionRate" name="Progression rate" fill="#111827" />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="mt-3 grid gap-2 text-sm">
                      {report.stageProgression.slice(0, 5).map((row) => (
                        <div key={row.stageName} className="flex items-center justify-between rounded-md bg-slate-50 px-3 py-2">
                          <span className="font-semibold text-slate-800">{row.stageName}</span>
                          <span className="font-bold text-slate-950">{formatPercent(row.progressionRate)}</span>
                        </div>
                      ))}
                    </div>
                  </>
                ) : <EmptyState label="No progression data." />}
              </CardContent>
            </Card>
          </section>

          <Card>
            <CardContent className="overflow-x-auto p-5">
              <h2 className="text-sm font-black uppercase tracking-[0.16em] text-slate-900">Quarterly Comparison</h2>
              <table className="mt-4 w-full min-w-[860px] text-sm">
                <thead className="text-left text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">
                  <tr>
                    <th className="py-2">Quarter</th>
                    <th className="py-2 text-right">Deals Created</th>
                    <th className="py-2 text-right">Won</th>
                    <th className="py-2 text-right">Lost</th>
                    <th className="py-2 text-right">Win Rate</th>
                    <th className="py-2 text-right">Avg Deal Size</th>
                    <th className="py-2 text-right">Pipeline EOP</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {report.quarterlyComparison.map((row) => (
                    <tr key={row.quarter}>
                      <td className="py-3 font-semibold text-slate-900">{row.quarter}</td>
                      <td className="py-3 text-right">{formatNumber(row.dealsCreated)}</td>
                      <td className="py-3 text-right">{formatNumber(row.won)}</td>
                      <td className="py-3 text-right">{formatNumber(row.lost)}</td>
                      <td className="py-3 text-right">{formatPercent(row.winRate)}</td>
                      <td className="py-3 text-right">{formatCurrency(row.avgDealSize)}</td>
                      <td className="py-3 text-right">{formatCurrency(row.pipelineEndValue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </div>
      ) : <EmptyState label="No executive trends data for this range." />}
    </ReportPageShell>
  );
}

function formatKpiValue(value: number, format: "currency" | "number" | "percent") {
  if (format === "currency") return formatCurrency(value);
  if (format === "percent") return formatPercent(value);
  return formatNumber(value);
}
