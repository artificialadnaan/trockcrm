import { Bar, BarChart, CartesianGrid, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { PageHeader } from "@/components/layout/page-header";
import { ReportFilterBar, useReportFilters } from "@/components/reports/report-filter-bar";
import { useForecastAccuracyReport } from "@/hooks/use-reports";
import {
  DealLink,
  EmptyState,
  ErrorState,
  KpiCard,
  LoadingState,
  ReportPanel,
  formatCurrency,
  formatDate,
  formatPercent,
} from "./performance-report-ui";

export function ForecastAccuracyPage() {
  const { query } = useReportFilters();
  const { data, loading, error } = useForecastAccuracyReport(query);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Performance"
        title="Forecast Accuracy"
        description="Commit, best case, weighted pipeline, and actual won reliability by period."
      />
      <ReportFilterBar />

      {loading ? <LoadingState /> : null}
      {error ? <ErrorState message={error} /> : null}
      {!loading && !error && data ? (
        <>
          <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <KpiCard label="Commit" value={formatCurrency(data.kpis.commit)} />
            <KpiCard label="Best Case" value={formatCurrency(data.kpis.bestCase)} />
            <KpiCard label="Pipeline Weighted" value={formatCurrency(data.kpis.pipelineWeighted)} />
            <KpiCard label="Won Actual" value={formatCurrency(data.kpis.wonActual)} />
            <KpiCard label="Accuracy Variance" value={formatPercent(data.accuracy.variancePercent)} />
          </section>

          <ReportPanel title="Forecast vs Actual">
            {data.monthly.length === 0 ? <EmptyState /> : (
              <div className="h-80">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.monthly}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={(value) => `$${Math.round(Number(value) / 1000)}k`} />
                    <Tooltip formatter={(value) => formatCurrency(Number(value))} />
                    <Legend />
                    <Bar dataKey="commit" name="Commit" stackId="forecast" fill="#111827" />
                    <Bar dataKey="bestCase" name="Best Case" stackId="forecast" fill="#64748b" />
                    <Bar dataKey="pipelineWeighted" name="Weighted Pipeline" stackId="forecast" fill="#CC0000" />
                    <Line type="monotone" dataKey="wonActual" name="Actual Won" stroke="#0f766e" strokeWidth={3} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </ReportPanel>

          <ReportPanel title="Pipeline At Risk">
            {data.pipelineAtRisk.length === 0 ? <EmptyState /> : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-left text-xs font-black uppercase tracking-[0.14em] text-slate-500">
                    <tr><th className="py-2">Deal Name</th><th>Owner</th><th>Stage</th><th>Value</th><th>Expected Close Date</th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.pipelineAtRisk.map((deal) => (
                      <tr key={deal.dealId}>
                        <td className="py-3"><DealLink dealId={deal.dealId}>{deal.dealName}</DealLink></td>
                        <td>{deal.ownerName}</td>
                        <td>{deal.stageName}</td>
                        <td>{formatCurrency(deal.value)}</td>
                        <td>{formatDate(deal.expectedCloseDate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </ReportPanel>
        </>
      ) : null}
    </div>
  );
}
