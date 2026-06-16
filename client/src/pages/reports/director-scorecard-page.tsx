import type { ReactNode } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { ReportFilterBar, useReportFilters } from "@/components/reports/report-filter-bar";
import { ExportExcelButton } from "@/components/reports/export-excel-button";
import { useTableSort, SortHeaderButton, type SortColumn } from "@/components/reports/sortable";
import { useDirectorScorecardReport, type DirectorScorecardReport } from "@/hooks/use-reports";
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

type RepPerfRow = DirectorScorecardReport["repPerformance"][number];
type AtRiskDealRow = DirectorScorecardReport["topAtRiskDeals"][number];

type SortedColumn<Row> = SortColumn<Row> & {
  header: string;
  numeric: boolean;
  cell: (row: Row) => ReactNode;
};

const HEADER_CLASS = "text-xs font-black uppercase tracking-[0.14em] text-slate-500";

const REP_PERF_COLUMNS: ReadonlyArray<SortedColumn<RepPerfRow>> = [
  { key: "repName", type: "text", accessor: (r) => r.repName, header: "Rep Name", numeric: false, cell: (r) => <span className="font-semibold text-slate-900">{r.repName}</span> },
  { key: "openDeals", type: "number", accessor: (r) => r.openDeals, header: "Open Deals", numeric: true, cell: (r) => formatNumber(r.openDeals) },
  { key: "pipelineValue", type: "number", accessor: (r) => r.pipelineValue, header: "Pipeline Value", numeric: true, cell: (r) => formatCurrency(r.pipelineValue) },
  { key: "wonThisPeriod", type: "number", accessor: (r) => r.wonThisPeriod, header: "Won This Period", numeric: true, cell: (r) => formatNumber(r.wonThisPeriod) },
  { key: "winRate", type: "number", accessor: (r) => r.winRate, header: "Win Rate", numeric: true, cell: (r) => formatPercent(r.winRate) },
  { key: "activityScore", type: "number", accessor: (r) => r.activityScore, header: "Activity Score", numeric: true, cell: (r) => formatNumber(r.activityScore) },
];

const TOP_ATRISK_COLUMNS: ReadonlyArray<SortedColumn<AtRiskDealRow>> = [
  { key: "dealName", type: "text", accessor: (r) => r.dealName, header: "Deal Name", numeric: false, cell: (r) => <DealLink dealId={r.dealId}>{r.dealName}</DealLink> },
  { key: "ownerName", type: "text", accessor: (r) => r.ownerName, header: "Owner", numeric: false, cell: (r) => r.ownerName },
  { key: "stageName", type: "text", accessor: (r) => r.stageName, header: "Stage", numeric: false, cell: (r) => r.stageName },
  { key: "daysInStage", type: "number", accessor: (r) => r.daysInStage, header: "Days In Stage", numeric: true, cell: (r) => formatNumber(r.daysInStage) },
  { key: "value", type: "number", accessor: (r) => r.value, header: "Value", numeric: true, cell: (r) => formatCurrency(r.value) },
  { key: "lastActivityDate", type: "date", accessor: (r) => r.lastActivityDate, header: "Last Activity Date", numeric: false, cell: (r) => formatDate(r.lastActivityDate) },
];

function SortableReportTable<Row>({
  rows,
  columns,
  getRowKey,
}: {
  rows: Row[];
  columns: ReadonlyArray<SortedColumn<Row>>;
  getRowKey: (row: Row) => string;
}) {
  const { sortedRows, toggle, getHeaderProps } = useTableSort(rows, columns);
  if (rows.length === 0) return <EmptyState />;
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className={`text-left ${HEADER_CLASS}`}>
          <tr>
            {columns.map((col) => {
              const hp = getHeaderProps(col.key);
              return (
                <th
                  key={col.key}
                  className={col.numeric ? "py-2 text-right" : "py-2"}
                  aria-sort={hp.active ? (hp.dir === "asc" ? "ascending" : "descending") : "none"}
                >
                  <SortHeaderButton
                    label={col.header}
                    numeric={col.numeric}
                    active={hp.active}
                    dir={hp.dir}
                    onClick={() => toggle(col.key)}
                    className={HEADER_CLASS}
                  />
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {sortedRows.map((row) => (
            <tr key={getRowKey(row)}>
              {columns.map((col) => (
                <td key={col.key} className={col.numeric ? "py-3 text-right tabular-nums" : "py-3"}>
                  {col.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

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
            <SortableReportTable rows={data.repPerformance} columns={REP_PERF_COLUMNS} getRowKey={(r) => r.repName} />
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
            <SortableReportTable rows={data.topAtRiskDeals} columns={TOP_ATRISK_COLUMNS} getRowKey={(r) => r.dealId} />
          </ReportPanel>
        </>
      ) : null}
    </div>
  );
}
