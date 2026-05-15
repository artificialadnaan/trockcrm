import { PageHeader } from "@/components/layout/page-header";
import { ReportFilterBar, useReportFilters } from "@/components/reports/report-filter-bar";
import { ExportExcelButton } from "@/components/reports/export-excel-button";
import { useDirectorScorecardReport } from "@/hooks/use-reports";
import { sheetsFromReport } from "@/lib/excel-export";
import {
  DealLink,
  EmptyState,
  ErrorState,
  KpiCard,
  LoadingState,
  ReportPanel,
  formatCurrency,
  formatDate,
  formatNumber,
  formatPercent,
} from "./performance-report-ui";

export function DirectorScorecardPage() {
  const { query } = useReportFilters();
  const { data, loading, error } = useDirectorScorecardReport(query);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Performance"
        title="Director Scorecard"
        description="Executive view of targets, risk, and output across the active sales pipeline."
      />
      <ReportFilterBar />
      <div className="flex justify-end">
        <ExportExcelButton
          filename="director-scorecard-report"
          sheets={sheetsFromReport("Director Scorecard", data)}
          disabled={loading || !data}
        />
      </div>

      {loading ? <LoadingState /> : null}
      {error ? <ErrorState message={error} /> : null}
      {!loading && !error && data ? (
        <>
          <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Total Pipeline Value" value={formatCurrency(data.kpis.totalPipelineValue)} />
            <KpiCard label="Open Deal Count" value={formatNumber(data.kpis.openDealCount)} />
            <KpiCard label="Forecast For Period" value={formatCurrency(data.kpis.forecastCommit)} helper={`Best case ${formatCurrency(data.kpis.forecastBestCase)}`} />
            <KpiCard label="Win Rate" value={formatPercent(data.kpis.winRate)} />
          </section>

          <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Deals At Risk" value={formatNumber(data.risks.dealsAtRisk)} helper={formatCurrency(data.risks.dealsAtRiskValue)} />
            <KpiCard label="Stalled Accounts" value={formatNumber(data.risks.stalledAccounts)} helper="No activity >14 days" />
            <KpiCard label="Overdue Tasks" value={formatNumber(data.risks.overdueTasks)} />
            <KpiCard label="Missed Follow-ups" value={formatNumber(data.risks.missedFollowUps)} helper="Deal activity >14 days" />
          </section>

          <ReportPanel title="Rep Performance">
            {data.repPerformance.length === 0 ? <EmptyState /> : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-left text-xs font-black uppercase tracking-[0.14em] text-slate-500">
                    <tr><th className="py-2">Rep Name</th><th>Open Deals</th><th>Pipeline Value</th><th>Won This Period</th><th>Win Rate</th><th>Activity Score</th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.repPerformance.map((row) => (
                      <tr key={row.repName}>
                        <td className="py-3 font-semibold text-slate-900">{row.repName}</td>
                        <td>{formatNumber(row.openDeals)}</td>
                        <td>{formatCurrency(row.pipelineValue)}</td>
                        <td>{formatNumber(row.wonThisPeriod)}</td>
                        <td>{formatPercent(row.winRate)}</td>
                        <td>{formatNumber(row.activityScore)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </ReportPanel>

          <ReportPanel title="Office Comparison">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {data.officeComparison.map((office) => (
                <div key={office.officeName} className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                  <p className="text-lg font-black text-slate-950">{office.officeName}</p>
                  <p className="mt-2 text-sm font-semibold text-slate-600">{formatCurrency(office.pipelineValue)} pipeline</p>
                  <p className="text-sm text-slate-500">{formatNumber(office.openCount)} open deals · {formatPercent(office.winRate)} win rate</p>
                </div>
              ))}
              {data.officeComparison.length === 0 ? <EmptyState /> : null}
            </div>
          </ReportPanel>

          <ReportPanel title="Top 5 At-Risk Deals">
            {data.topAtRiskDeals.length === 0 ? <EmptyState /> : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-left text-xs font-black uppercase tracking-[0.14em] text-slate-500">
                    <tr><th className="py-2">Deal Name</th><th>Owner</th><th>Stage</th><th>Days In Stage</th><th>Value</th><th>Last Activity Date</th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.topAtRiskDeals.map((deal) => (
                      <tr key={deal.dealId}>
                        <td className="py-3"><DealLink dealId={deal.dealId}>{deal.dealName}</DealLink></td>
                        <td>{deal.ownerName}</td>
                        <td>{deal.stageName}</td>
                        <td>{formatNumber(deal.daysInStage)}</td>
                        <td>{formatCurrency(deal.value)}</td>
                        <td>{formatDate(deal.lastActivityDate)}</td>
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
