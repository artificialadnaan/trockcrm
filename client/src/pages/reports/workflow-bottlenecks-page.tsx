import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { ReportFilterBar, useReportFilters } from "@/components/reports/report-filter-bar";
import { useWorkflowBottlenecksReport } from "@/hooks/use-reports";
import { sheetsFromReport } from "@/lib/excel-export";
import {
  DealLink,
  EmptyState,
  ErrorState,
  formatDays,
  formatNumber,
  formatUsd,
  KpiCard,
  KpiGrid,
  LoadingState,
  OperationsReportShell,
  ReportPanel,
  ScrollTable,
} from "./operations-report-common";

function heatClass(days: number) {
  if (days > 30) return "bg-red-600";
  if (days >= 15) return "bg-amber-500";
  return "bg-emerald-600";
}

export function WorkflowBottlenecksPage() {
  const { query } = useReportFilters();
  const { data, loading, error } = useWorkflowBottlenecksReport(query);
  const maxStageDays = Math.max(1, ...(data?.stageAging.map((stage) => stage.avgDaysInStage) ?? [1]));

  return (
    <OperationsReportShell
      title="Workflow Bottlenecks"
      description="Stage aging, stuck deals, and handoff pressure for active work."
      exportFilename="workflow-bottlenecks-report"
      exportSheets={sheetsFromReport("Workflow Bottlenecks", data)}
    >
      <ReportFilterBar />
      {loading ? <LoadingState /> : null}
      {error ? <ErrorState message={error} /> : null}
      {!loading && !error && data ? (
        <>
          <KpiGrid>
            <KpiCard label="Stuck deals over 30 days" value={formatNumber(data.kpis.totalStuckDeals)} tone="red" />
            <KpiCard label="Average deal age" value={formatDays(data.kpis.avgDealAge)} tone="amber" />
            <KpiCard label="Longest stuck age" value={formatDays(data.kpis.longestStuckDealAge)} tone="red" />
            <KpiCard label="Stages with 5+ stuck" value={formatNumber(data.kpis.stagesWithFivePlusStuckDeals)} />
          </KpiGrid>

          <ReportPanel title="Bottleneck Chart" action={<Legend />}>
            {data.stageAging.length === 0 ? (
              <EmptyState message="No open active deals matched the selected filters." />
            ) : (
              <div className="space-y-3">
                {data.stageAging.map((stage) => (
                  <div key={stage.stageName} className="grid gap-2 sm:grid-cols-[220px_1fr_90px] sm:items-center">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold text-slate-900">{stage.stageName}</p>
                      <p className="text-xs text-slate-500">{formatNumber(stage.openDealCount)} open</p>
                    </div>
                    <div className="h-4 rounded-full bg-slate-100">
                      <div
                        className={`h-4 rounded-full ${heatClass(stage.avgDaysInStage)}`}
                        style={{ width: `${Math.max(4, (stage.avgDaysInStage / maxStageDays) * 100)}%` }}
                        title={`${stage.stageName}: avg ${stage.avgDaysInStage} days, median ${stage.medianDaysInStage} days`}
                      />
                    </div>
                    <p className="text-sm font-black text-slate-900">{stage.avgDaysInStage} avg</p>
                  </div>
                ))}
              </div>
            )}
          </ReportPanel>

          <ReportPanel title="Stage Aging">
            <ScrollTable>
              <table className="min-w-full text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Stage Name</th>
                    <th className="px-3 py-2">Open Deal Count</th>
                    <th className="px-3 py-2">Avg Days</th>
                    <th className="px-3 py-2">Median Days</th>
                    <th className="px-3 py-2">Max Days</th>
                    <th className="px-3 py-2">Stuck &gt;30</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.stageAging.map((stage) => (
                    <tr key={stage.stageName}>
                      <td className="px-3 py-3 font-semibold text-slate-900">{stage.stageName}</td>
                      <td className="px-3 py-3">{formatNumber(stage.openDealCount)}</td>
                      <td className="px-3 py-3">{stage.avgDaysInStage}</td>
                      <td className="px-3 py-3">{stage.medianDaysInStage}</td>
                      <td className="px-3 py-3">{formatNumber(stage.maxDaysInStage)}</td>
                      <td className="px-3 py-3 font-bold text-red-700">{formatNumber(stage.stuckDealCount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollTable>
          </ReportPanel>

          <DealTable title="Top 15 Stuck Deals" rows={data.topStuckDeals} />

          <DealTable
            title="Handoff Blockages"
            rows={data.handoffBlockages}
            emptyMessage="No handoff-stage deals are currently over the 15-day watch threshold."
            icon={<AlertTriangle className="h-4 w-4 text-amber-600" />}
          />
        </>
      ) : null}
    </OperationsReportShell>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap gap-3 text-xs font-semibold text-slate-600">
      <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-emerald-600" />Under 15</span>
      <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-amber-500" />15-30</span>
      <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-red-600" />Over 30</span>
    </div>
  );
}

function DealTable({
  title,
  rows,
  emptyMessage = "No stuck deals matched the selected filters.",
  icon,
}: {
  title: string;
  rows: Array<{
    dealId: string;
    dealName: string;
    ownerName: string;
    stageName: string;
    daysInStage: number;
    daysSinceLastActivity: number | null;
    value: number;
    projectNumber: string | null;
  }>;
  emptyMessage?: string;
  icon?: ReactNode;
}) {
  return (
    <ReportPanel title={title} action={icon}>
      {rows.length === 0 ? (
        <EmptyState message={emptyMessage} />
      ) : (
        <ScrollTable>
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">Deal Name</th>
                <th className="px-3 py-2">Owner</th>
                <th className="px-3 py-2">Stage</th>
                <th className="px-3 py-2">Days in Stage</th>
                <th className="px-3 py-2">Days Since Last Activity</th>
                <th className="px-3 py-2">Value</th>
                <th className="px-3 py-2">Project Number</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((deal) => (
                <tr key={deal.dealId}>
                  <td className="px-3 py-3"><DealLink dealId={deal.dealId}>{deal.dealName}</DealLink></td>
                  <td className="px-3 py-3">{deal.ownerName}</td>
                  <td className="px-3 py-3">{deal.stageName}</td>
                  <td className="px-3 py-3 font-bold text-red-700">{formatDays(deal.daysInStage)}</td>
                  <td className="px-3 py-3">{formatDays(deal.daysSinceLastActivity)}</td>
                  <td className="px-3 py-3">{formatUsd(deal.value)}</td>
                  <td className="px-3 py-3">{deal.projectNumber ?? "Not assigned"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollTable>
      )}
    </ReportPanel>
  );
}
