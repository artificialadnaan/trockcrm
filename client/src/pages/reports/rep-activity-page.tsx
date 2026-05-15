import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { PageHeader } from "@/components/layout/page-header";
import { ReportFilterBar, useReportFilters } from "@/components/reports/report-filter-bar";
import { ExportExcelButton } from "@/components/reports/export-excel-button";
import { useRepActivityReport } from "@/hooks/use-reports";
import { sheetsFromReport } from "@/lib/excel-export";
import {
  EmptyState,
  ErrorState,
  KpiCard,
  LoadingState,
  ReportPanel,
  formatCurrency,
  formatDate,
  formatNumber,
} from "./performance-report-ui";

const COLORS = ["#CC0000", "#111827", "#64748b", "#f97316", "#0f766e", "#7c3aed"];

export function RepActivityPage() {
  const { query } = useReportFilters();
  const { data, loading, error } = useRepActivityReport(query);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Performance"
        title="Rep Activity"
        description="Touchpoints, follow-ups, and stalled accounts by owner."
      />
      <ReportFilterBar />
      <div className="flex justify-end">
        <ExportExcelButton
          filename="rep-activity-report"
          sheets={sheetsFromReport("Rep Activity", data)}
          disabled={loading || !data}
        />
      </div>

      {loading ? <LoadingState /> : null}
      {error ? <ErrorState message={error} /> : null}
      {!loading && !error && data ? (
        <>
          <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-6">
            <KpiCard label="Total Touchpoints" value={formatNumber(data.kpis.totalTouchpoints)} />
            <KpiCard label="Deals Worked" value={formatNumber(data.kpis.dealsWorked)} />
            <KpiCard label="Calls" value={formatNumber(data.kpis.calls)} />
            <KpiCard label="Emails" value={formatNumber(data.kpis.emails)} />
            <KpiCard label="Meetings" value={formatNumber(data.kpis.meetings)} />
            <KpiCard label="Follow-ups Completed" value={formatNumber(data.kpis.followUpsCompleted)} />
          </section>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <ReportPanel title="Activity Timeline">
              {data.timeline.length === 0 ? <EmptyState /> : (
                <div className="h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data.timeline}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                      <Tooltip />
                      <Bar dataKey="touchpoints" name="Touchpoints" fill="#CC0000" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </ReportPanel>

            <ReportPanel title="Activity By Type">
              {data.activityByType.length === 0 ? <EmptyState /> : (
                <div className="h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={data.activityByType} dataKey="count" nameKey="type" outerRadius={90} label>
                        {data.activityByType.map((entry, index) => (
                          <Cell key={entry.type} fill={COLORS[index % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              )}
            </ReportPanel>
          </div>

          <ReportPanel title="Stalled Accounts">
            {data.stalledAccounts.length === 0 ? <EmptyState /> : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-left text-xs font-black uppercase tracking-[0.14em] text-slate-500">
                    <tr><th className="py-2">Account Name</th><th>Owner</th><th>Last Activity</th><th>Days Stalled</th><th>Open Deals</th><th>Total Open Value</th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.stalledAccounts.map((row) => (
                      <tr key={`${row.accountName}-${row.ownerName}`}>
                        <td className="py-3 font-semibold text-slate-900">{row.accountName}</td>
                        <td>{row.ownerName}</td>
                        <td>{formatDate(row.lastActivityDate)}</td>
                        <td>{formatNumber(row.daysStalled)}</td>
                        <td>{formatNumber(row.openDeals)}</td>
                        <td>{formatCurrency(row.totalOpenValue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </ReportPanel>

          <ReportPanel title="Per-Rep Summary">
            {data.repSummary.length === 0 ? <EmptyState /> : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-left text-xs font-black uppercase tracking-[0.14em] text-slate-500">
                    <tr><th className="py-2">Rep</th><th>Touchpoints</th><th>Active Deals</th><th>Stalled</th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.repSummary.map((row) => (
                      <tr key={row.repName}>
                        <td className="py-3 font-semibold text-slate-900">{row.repName}</td>
                        <td>{formatNumber(row.touchpoints)}</td>
                        <td>{formatNumber(row.activeDeals)}</td>
                        <td>{formatNumber(row.stalledAccounts)}</td>
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
