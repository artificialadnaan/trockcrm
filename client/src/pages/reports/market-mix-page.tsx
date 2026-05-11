import { Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import { useReportFilters } from "@/components/reports/report-filter-bar";
import { useMarketMixReport } from "@/hooks/use-reports";
import { CHART_COLORS, EmptyState, formatCurrency, formatNumber, formatPercent, KpiCard, ReportPageShell } from "./analytics-page-shared";

export function MarketMixPage() {
  const { query } = useReportFilters();
  const { data, loading, error, refetch } = useMarketMixReport(query);
  const report = data;

  return (
    <ReportPageShell
      title="Market Mix"
      description="Work by vertical, property type, and region with quarterly won-value trends."
      loading={loading}
      error={error}
      onRefresh={() => void refetch()}
    >
      {report ? (
        <div className="space-y-6">
          <section className="grid gap-4 md:grid-cols-4">
            <KpiCard label="Total deal count" value={formatNumber(report.kpis.totalDealCount)} />
            <KpiCard label="Total won value" value={formatCurrency(report.kpis.totalWonValue)} />
            <KpiCard label="Active markets" value={formatNumber(report.kpis.activeMarkets)} />
            <KpiCard label="Most active region" value={report.kpis.mostActiveRegion} />
          </section>

          <section className="grid gap-4 xl:grid-cols-3">
            <PiePanel title="Deals by Vertical" data={report.verticalMix} />
            <PiePanel title="Deals by Property Type" data={report.propertyTypeMix} />
            <PiePanel title="Deals by Region" data={report.regionMix} />
          </section>

          <Card>
            <CardContent className="p-5">
              <h2 className="text-sm font-black uppercase tracking-[0.16em] text-slate-900">Won Value by Vertical</h2>
              {report.quarterlyWonByVertical.length ? (
                <div className="mt-4 h-80">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={report.quarterlyWonByVertical}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="quarter" />
                      <YAxis tickFormatter={(value) => `$${Number(value) / 1000}k`} />
                      <Tooltip formatter={(value) => formatCurrency(Number(value))} />
                      <Legend />
                      <Bar dataKey="wonValue" name="Won value" fill="#cc0000" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : <EmptyState label="No won-value trend data for this range." />}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="overflow-x-auto p-5">
              <h2 className="text-sm font-black uppercase tracking-[0.16em] text-slate-900">Vertical Breakdown</h2>
              <table className="mt-4 w-full min-w-[720px] text-sm">
                <thead className="text-left text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">
                  <tr>
                    <th className="py-2">Vertical</th>
                    <th className="py-2 text-right">Active Deals</th>
                    <th className="py-2 text-right">Won Last Year</th>
                    <th className="py-2 text-right">Win Rate</th>
                    <th className="py-2 text-right">Avg Deal Size</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {report.breakdown.map((row) => (
                    <tr key={row.vertical}>
                      <td className="py-3 font-semibold text-slate-900">{row.vertical}</td>
                      <td className="py-3 text-right">{formatNumber(row.activeDeals)}</td>
                      <td className="py-3 text-right">{formatCurrency(row.wonLastYear)}</td>
                      <td className="py-3 text-right">{formatPercent(row.winRate)}</td>
                      <td className="py-3 text-right">{formatCurrency(row.avgDealSize)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </div>
      ) : <EmptyState label="No market mix data for this range." />}
    </ReportPageShell>
  );
}

function PiePanel({ title, data }: { title: string; data: Array<{ name: string; dealCount: number; wonValue: number }> }) {
  return (
    <Card>
      <CardContent className="p-5">
        <h2 className="text-sm font-black uppercase tracking-[0.16em] text-slate-900">{title}</h2>
        {data.length ? (
          <div className="mt-4 h-72">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={data} dataKey="dealCount" nameKey="name" outerRadius={82} label>
                  {data.map((entry, index) => (
                    <Cell key={entry.name} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(value, name) => [formatNumber(Number(value)), String(name)]} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        ) : <EmptyState label="No segment data." />}
      </CardContent>
    </Card>
  );
}
