import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import { useReportFilters } from "@/components/reports/report-filter-bar";
import { useCustomerConcentrationReport } from "@/hooks/use-reports";
import { EmptyState, formatCurrency, formatDate, formatNumber, formatPercent, KpiCard, ReportPageShell } from "./analytics-page-shared";

export function CustomerConcentrationPage() {
  const { query } = useReportFilters();
  const { data, loading, error, refetch } = useCustomerConcentrationReport(query);
  const report = data;

  return (
    <ReportPageShell
      title="Customer Concentration"
      description="Revenue and opportunity exposure by account, including concentration risk and stale open customers."
      loading={loading}
      error={error}
      onRefresh={() => void refetch()}
    >
      {report ? (
        <div className="space-y-6">
          <section className="grid gap-4 md:grid-cols-4">
            <KpiCard label="Active customers" value={formatNumber(report.kpis.totalActiveCustomers)} />
            <KpiCard label="Total open value" value={formatCurrency(report.kpis.totalOpenValue)} />
            <KpiCard label="Top customer share" value={formatPercent(report.kpis.topCustomerPipelinePercent)} />
            <KpiCard label="Customers above $1M" value={formatNumber(report.kpis.customersOverOneMillionOpen)} />
          </section>

          <Card>
            <CardContent className="overflow-x-auto p-5">
              <h2 className="text-sm font-black uppercase tracking-[0.16em] text-slate-900">Top 20 Customers</h2>
              <table className="mt-4 w-full min-w-[860px] text-sm">
                <thead className="text-left text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">
                  <tr>
                    <th className="py-2">Company Name</th>
                    <th className="py-2 text-right">Active Deals</th>
                    <th className="py-2 text-right">Total Open Value</th>
                    <th className="py-2 text-right">Total Won</th>
                    <th className="py-2">Last Activity</th>
                    <th className="py-2">Account Owner</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {report.topCustomers.map((row, index) => (
                    <tr key={row.companyName} className={index < 3 ? "bg-red-50/60" : undefined}>
                      <td className="py-3 font-semibold text-slate-900">{row.companyName}</td>
                      <td className="py-3 text-right">{formatNumber(row.activeDeals)}</td>
                      <td className="py-3 text-right">{formatCurrency(row.totalOpenValue)}</td>
                      <td className="py-3 text-right">{formatCurrency(row.totalWonLifetime)}</td>
                      <td className="py-3">{formatDate(row.lastActivityAt)}</td>
                      <td className="py-3">{row.accountOwner}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {report.topCustomers.length === 0 ? <EmptyState label="No active customer exposure for this range." /> : null}
            </CardContent>
          </Card>

          <section className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardContent className="p-5">
                <h2 className="text-sm font-black uppercase tracking-[0.16em] text-slate-900">Pareto Concentration</h2>
                {report.pareto.length ? (
                  <div className="mt-4 h-72">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={report.pareto}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="rank" />
                        <YAxis tickFormatter={(value) => `${value}%`} />
                        <Tooltip formatter={(value) => formatPercent(Number(value))} />
                        <Line type="monotone" dataKey="cumulativePipelinePercent" name="Cumulative pipeline %" stroke="#cc0000" strokeWidth={2} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                ) : <EmptyState label="No concentration chart data." />}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-5">
                <h2 className="text-sm font-black uppercase tracking-[0.16em] text-slate-900">Revenue Distribution</h2>
                {report.distribution.length ? (
                  <div className="mt-4 h-72">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={report.distribution}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="bucket" />
                        <YAxis allowDecimals={false} />
                        <Tooltip formatter={(value) => formatNumber(Number(value))} />
                        <Bar dataKey="customerCount" name="Customers" fill="#111827" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                ) : <EmptyState label="No distribution data." />}
              </CardContent>
            </Card>
          </section>

          <Card>
            <CardContent className="overflow-x-auto p-5">
              <h2 className="text-sm font-black uppercase tracking-[0.16em] text-slate-900">Stale Customers</h2>
              <table className="mt-4 w-full min-w-[720px] text-sm">
                <thead className="text-left text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">
                  <tr>
                    <th className="py-2">Company</th>
                    <th className="py-2">Owner</th>
                    <th className="py-2 text-right">Open Deals</th>
                    <th className="py-2 text-right">Open Value</th>
                    <th className="py-2 text-right">Days Stale</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {report.staleCustomers.map((row) => (
                    <tr key={`${row.companyName}-${row.ownerName}`}>
                      <td className="py-3 font-semibold text-slate-900">{row.companyName}</td>
                      <td className="py-3">{row.ownerName}</td>
                      <td className="py-3 text-right">{formatNumber(row.openDeals)}</td>
                      <td className="py-3 text-right">{formatCurrency(row.openValue)}</td>
                      <td className="py-3 text-right">{formatNumber(row.daysStale)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </div>
      ) : <EmptyState label="No customer concentration data for this range." />}
    </ReportPageShell>
  );
}
