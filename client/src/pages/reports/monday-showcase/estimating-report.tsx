import { useState, type ReactNode } from "react";
import { SortHeaderButton, ariaSort, useTableSort, type SortColumn } from "@/components/reports/sortable";
import { formatDayShort, int, usd } from "../evidence-kit";
import { ScrollSyncX } from "../scroll-sync-x";
import { WEEK_MODE_LABELS } from "../week-mode";
import {
  A1DealLink,
  EstimatingSupportingRecordsDialog,
  type A1DrillRequest,
} from "./estimating-supporting-records-dialog";
import type {
  CurrentEstimatingProject,
  EstimateSentProject,
  MondayShowcaseData,
  RfpBySalesperson,
  RfpInitiatedProject,
} from "./types";

function formatCentralDay(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return formatDayShort(value);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
  }).format(date);
}

function formatCentralTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date)} CT`;
}

function pct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
}

function signedUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value > 0 ? `+${usd(value)}` : usd(value);
}

function reference(projectNumber: string | null, dealNumber: string | null): string {
  return projectNumber ?? dealNumber ?? "—";
}

function Coverage({ children }: { children: ReactNode }) {
  return <p className="mt-1 text-[11px] leading-4 text-slate-500">{children}</p>;
}

function MetricTile({
  label,
  value,
  detail,
  tone = "slate",
  onOpen,
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "slate" | "violet" | "sky" | "emerald";
  onOpen?: () => void;
}) {
  const colors = {
    slate: "border-slate-200 bg-white text-slate-900",
    violet: "border-violet-200 bg-violet-50/70 text-violet-900",
    sky: "border-sky-200 bg-sky-50/70 text-sky-900",
    emerald: "border-emerald-200 bg-emerald-50/70 text-emerald-900",
  } as const;
  return (
    <div className={`rounded-xl border p-3 ${colors[tone]}`}>
      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</p>
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Show supporting records for ${label}`}
          className="mt-1 block text-left text-xl font-black tabular-nums underline decoration-dotted decoration-slate-400 underline-offset-4 transition hover:text-brand-red hover:decoration-brand-red focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red"
        >
          {value}
        </button>
      ) : (
        <p className="mt-1 text-xl font-black tabular-nums">{value}</p>
      )}
      <p className="mt-1 text-[11px] leading-4 text-slate-600">{detail}</p>
    </div>
  );
}

function SectionHeading({ id, eyebrow, title, children }: { id: string; eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">{eyebrow}</p>
        <h2 id={id} className="mt-0.5 text-lg font-black tracking-tight text-slate-900">
          {title}
        </h2>
      </div>
      {children}
    </div>
  );
}

function EmptyRows({ colSpan, label }: { colSpan: number; label: string }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-8 text-center text-sm text-slate-500">
        {label}
      </td>
    </tr>
  );
}

interface SortControls {
  toggle: (key: string) => void;
  getHeaderProps: (key: string) => { active: boolean; dir: "asc" | "desc" | null };
}

function SortableHeader({
  label,
  sortKey,
  sort,
  numeric,
  className,
}: {
  label: string;
  sortKey: string;
  sort: SortControls;
  numeric?: boolean;
  className: string;
}) {
  const header = sort.getHeaderProps(sortKey);
  return (
    <th className={className} aria-sort={ariaSort(header.active, header.dir)}>
      <SortHeaderButton
        label={label}
        numeric={numeric}
        active={header.active}
        dir={header.dir}
        onClick={() => sort.toggle(sortKey)}
      />
    </th>
  );
}

function DrillPill({ children, label, onOpen, className }: { children: ReactNode; label: string; onOpen: () => void; className: string }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Show supporting records for ${label}`}
      className={`${className} underline decoration-dotted underline-offset-4 transition hover:brightness-75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red`}
    >
      {children}
    </button>
  );
}

const CURRENT_SORT_COLUMNS: readonly SortColumn<CurrentEstimatingProject>[] = [
  { key: "name", type: "text", accessor: (project) => project.name },
  { key: "reference", type: "text", accessor: (project) => project.projectNumber ?? project.dealNumber },
  { key: "stage", type: "text", accessor: (project) => project.stageLabel },
  { key: "dd", type: "number", accessor: (project) => project.ddEstimate },
  { key: "days", type: "number", accessor: (project) => project.daysInStage },
];

const RFP_SORT_COLUMNS: readonly SortColumn<RfpInitiatedProject>[] = [
  { key: "name", type: "text", accessor: (project) => project.name },
  { key: "reference", type: "text", accessor: (project) => project.projectNumber ?? project.dealNumber },
  { key: "requested", type: "date", accessor: (project) => project.requestedAt },
  { key: "status", type: "text", accessor: (project) => project.currentRfpStatus },
  { key: "rep", type: "text", accessor: (project) => project.assignedRepName },
  { key: "dd", type: "number", accessor: (project) => project.ddEstimate },
];

const SENT_SORT_COLUMNS: readonly SortColumn<EstimateSentProject>[] = [
  { key: "name", type: "text", accessor: (project) => project.name },
  { key: "reference", type: "text", accessor: (project) => project.projectNumber ?? project.dealNumber },
  { key: "sent", type: "date", accessor: (project) => project.sentAt },
  { key: "dd", type: "number", accessor: (project) => project.ddEstimate },
  { key: "latest_total", type: "number", accessor: (project) => project.latestBidBoardTotalSales },
  { key: "variance_amount", type: "number", accessor: (project) => project.varianceAmount },
  { key: "variance_percent", type: "number", accessor: (project) => project.variancePercent },
  { key: "margin", type: "number", accessor: (project) => project.marginPercent },
];

const SALESPERSON_SORT_COLUMNS: readonly SortColumn<RfpBySalesperson>[] = [
  { key: "rep", type: "text", accessor: (row) => row.repName },
  { key: "count", type: "number", accessor: (row) => row.count },
  { key: "dd", type: "number", accessor: (row) => row.ddValue },
  { key: "missing", type: "number", accessor: (row) => row.missingDdCount },
];

/**
 * A1 is intentionally direct evidence instead of a generic drill: its totals come from the same arrays
 * rendered below, and the extra DD / latest-export / variance / margin columns are all visible at once.
 */
export function VariantA1EstimatingReport({ data }: { data: MondayShowcaseData }) {
  const report = data.estimatingReport;
  const periodName = WEEK_MODE_LABELS[data.period.mode];
  const current = report.currentEstimating;
  const rfps = report.newRfps;
  const sent = report.estimatesSent;
  const [drill, setDrill] = useState<A1DrillRequest | null>(null);
  const currentSort = useTableSort(current.projects, CURRENT_SORT_COLUMNS);
  const rfpSort = useTableSort(rfps.projects, RFP_SORT_COLUMNS);
  const sentSort = useTableSort(sent.projects, SENT_SORT_COLUMNS);
  const salespersonSort = useTableSort(report.rfpBySalesperson, SALESPERSON_SORT_COLUMNS);

  return (
    <div className="space-y-5" data-testid="a1-estimating-report">
      <div className="rounded-xl border border-slate-200 bg-white px-4 py-3.5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">Report A1 · Estimating</p>
            <h1 className="mt-0.5 text-xl font-black tracking-tight text-slate-900">Estimating Report</h1>
            <p className="mt-1 text-sm text-slate-600">
              Live estimating workload plus activity for <span className="font-semibold text-slate-800">{periodName}</span> ({data.period.label}).
            </p>
          </div>
          <div className="rounded-lg bg-slate-100 px-3 py-2 text-right text-xs text-slate-600">
            <p className="font-semibold text-slate-800">Activity period</p>
            <p className="mt-0.5 tabular-nums">{data.period.label}</p>
          </div>
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <MetricTile
            label="Current estimating"
            value={`${int(current.count)} projects`}
            detail={`${usd(current.ddValue)} known DD · ${current.count - current.missingDdCount} of ${current.count} present`}
            tone="violet"
            onOpen={() => setDrill({ cohort: "current", scope: "all" })}
          />
          <MetricTile
            label="New RFPs initiated"
            value={`${int(rfps.count)} projects`}
            detail={`${usd(rfps.ddValue)} known DD · ${rfps.count - rfps.missingDdCount} of ${rfps.count} present`}
            tone="sky"
            onOpen={() => setDrill({ cohort: "rfp", scope: "all" })}
          />
          <MetricTile
            label="Projects sent"
            value={`${int(sent.count)} projects`}
            detail={`${usd(sent.latestBidBoardTotalSales)} latest Bid Board total`}
            tone="emerald"
            onOpen={() => setDrill({ cohort: "sent", scope: "all" })}
          />
          <MetricTile
            label="Blended margin"
            value={pct(sent.margin.blendedPercent)}
            detail={`Weighted across ${sent.margin.projectCount} of ${sent.count} sent projects`}
            onOpen={() => setDrill({ cohort: "sent", scope: "margin_usable" })}
          />
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Click a headline number to review its supporting records. Click a project name in a table to open that deal in a new tab.
        </p>
      </div>

      <section aria-labelledby="current-estimating-heading" className="rounded-xl border border-violet-200 bg-white p-4">
        <SectionHeading id="current-estimating-heading" eyebrow="Live workload" title="Current projects in Estimating">
          <DrillPill label="Current projects in Estimating" onOpen={() => setDrill({ cohort: "current", scope: "all" })} className="rounded-full bg-violet-100 px-2.5 py-1 text-[11px] font-semibold text-violet-800">
            {int(current.count)} projects · {usd(current.ddValue)} known DD
          </DrillPill>
        </SectionHeading>
        <p className="rounded-lg border border-violet-100 bg-violet-50/70 px-3 py-2 text-xs text-violet-900">
          <span className="font-semibold">Live current workload as of {formatCentralTimestamp(report.currentAsOf)}.</span>{" "}
          The period controls apply to the activity sections below, not this current queue.
        </p>
        <Coverage>
          DD Estimate is present for {int(current.count - current.missingDdCount)} of {int(current.count)} projects; the total includes known DD values only.
        </Coverage>
        <div className="mt-3 overflow-hidden rounded-lg border border-slate-200">
          <ScrollSyncX bodyClassName="overflow-x-auto" bodyLabel="Current projects in estimating">
            <table className="w-full min-w-[680px] text-sm">
              <thead className="border-b border-slate-200 bg-violet-50 text-left text-[10px] font-bold uppercase tracking-wide text-slate-500">
                <tr>
                  <SortableHeader label="Project" sortKey="name" sort={currentSort} className="px-3 py-2.5" />
                  <SortableHeader label="Project #" sortKey="reference" sort={currentSort} className="px-3 py-2.5" />
                  <SortableHeader label="Current stage" sortKey="stage" sort={currentSort} className="px-3 py-2.5" />
                  <SortableHeader label="DD Estimate" sortKey="dd" sort={currentSort} numeric className="px-3 py-2.5 text-right" />
                  <SortableHeader label="Time in stage" sortKey="days" sort={currentSort} numeric className="px-3 py-2.5 text-right" />
                </tr>
              </thead>
              <tbody>
                {currentSort.sortedRows.length === 0 ? (
                  <EmptyRows colSpan={5} label="No current projects are in Estimating for this department selection." />
                ) : (
                  currentSort.sortedRows.map((project) => (
                    <tr key={project.id} className="border-b border-slate-100 last:border-0 hover:bg-violet-50/30">
                      <td className="px-3 py-2.5"><A1DealLink dealId={project.id}>{project.name}</A1DealLink></td>
                      <td className="px-3 py-2.5 font-mono text-xs text-slate-600">{reference(project.projectNumber, project.dealNumber)}</td>
                      <td className="px-3 py-2.5 text-slate-600">{project.stageLabel}</td>
                      <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-slate-800">{usd(project.ddEstimate)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">
                        {project.daysInStage == null ? "—" : `${int(project.daysInStage)}d`}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </ScrollSyncX>
        </div>
      </section>

      <section aria-labelledby="new-rfps-heading" className="rounded-xl border border-sky-200 bg-white p-4">
        <SectionHeading id="new-rfps-heading" eyebrow={`Activity · ${periodName}`} title="New RFP submissions initiated">
          <DrillPill label="New RFP submissions initiated" onOpen={() => setDrill({ cohort: "rfp", scope: "all" })} className="rounded-full bg-sky-100 px-2.5 py-1 text-[11px] font-semibold text-sky-800">
            {int(rfps.count)} projects · {usd(rfps.ddValue)} known DD
          </DrillPill>
        </SectionHeading>
        <p className="rounded-lg border border-sky-100 bg-sky-50/70 px-3 py-2 text-xs text-sky-900">
          <span className="font-semibold">Current RFP-request cycle.</span> A cancelled or restarted cycle is not retained as a historical submission event.
        </p>
        <Coverage>
          DD Estimate is present for {int(rfps.count - rfps.missingDdCount)} of {int(rfps.count)} projects; current RFP status and sales ownership are shown below.
        </Coverage>
        <div className="mt-3 overflow-hidden rounded-lg border border-slate-200">
          <ScrollSyncX bodyClassName="overflow-x-auto" bodyLabel="New RFP submissions initiated">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="border-b border-slate-200 bg-sky-50 text-left text-[10px] font-bold uppercase tracking-wide text-slate-500">
                <tr>
                  <SortableHeader label="Project" sortKey="name" sort={rfpSort} className="px-3 py-2.5" />
                  <SortableHeader label="Project #" sortKey="reference" sort={rfpSort} className="px-3 py-2.5" />
                  <SortableHeader label="Request opened" sortKey="requested" sort={rfpSort} className="px-3 py-2.5" />
                  <SortableHeader label="Current RFP status" sortKey="status" sort={rfpSort} className="px-3 py-2.5" />
                  <SortableHeader label="Current assigned sales rep" sortKey="rep" sort={rfpSort} className="px-3 py-2.5" />
                  <SortableHeader label="DD Estimate" sortKey="dd" sort={rfpSort} numeric className="px-3 py-2.5 text-right" />
                </tr>
              </thead>
              <tbody>
                {rfpSort.sortedRows.length === 0 ? (
                  <EmptyRows colSpan={6} label="No RFP request cycles were opened in this activity period." />
                ) : (
                  rfpSort.sortedRows.map((project) => (
                    <tr key={project.id} className="border-b border-slate-100 last:border-0 hover:bg-sky-50/30">
                      <td className="px-3 py-2.5"><A1DealLink dealId={project.id}>{project.name}</A1DealLink></td>
                      <td className="px-3 py-2.5 font-mono text-xs text-slate-600">{reference(project.projectNumber, project.dealNumber)}</td>
                      <td className="px-3 py-2.5 tabular-nums text-slate-600">{formatCentralDay(project.requestedAt)}</td>
                      <td className="px-3 py-2.5 text-slate-600">{project.currentRfpStatus ?? "—"}</td>
                      <td className="px-3 py-2.5 text-slate-600">{project.assignedRepName}</td>
                      <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-slate-800">{usd(project.ddEstimate)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </ScrollSyncX>
        </div>
      </section>

      <section aria-labelledby="estimates-sent-heading" className="rounded-xl border border-emerald-200 bg-white p-4">
        <SectionHeading id="estimates-sent-heading" eyebrow={`Activity · ${periodName}`} title="Projects sent to client">
          <DrillPill label="Projects sent to client" onOpen={() => setDrill({ cohort: "sent", scope: "all" })} className="rounded-full bg-emerald-100 px-2.5 py-1 text-[11px] font-semibold text-emerald-800">
            {int(sent.count)} projects · {usd(sent.latestBidBoardTotalSales)} latest total
          </DrillPill>
        </SectionHeading>
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <span className="font-semibold">Source note:</span> rows are selected by their first sent-stage entry in this period. Estimate amount and margin reflect the latest Bid Board / CRM values as of page refresh, not an immutable send-time snapshot.
        </p>
        <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-5">
          <MetricTile
            label="Latest Bid Board Total Sales"
            value={usd(sent.latestBidBoardTotalSales)}
            detail={`${int(sent.count - sent.missingSentValueCount)} of ${int(sent.count)} projects have a latest total`}
            tone="emerald"
            onOpen={() => setDrill({ cohort: "sent", scope: "latest_total" })}
          />
          <MetricTile
            label="Comparable Current DD Estimate"
            value={usd(sent.comparison.dollarComparableDdValue)}
            detail={`Same ${int(sent.comparison.dollarComparableCount)}-project base as $ variance`}
            tone="emerald"
            onOpen={() => setDrill({ cohort: "sent", scope: "dollar_comparable" })}
          />
          <MetricTile
            label="Dollar variance"
            value={signedUsd(sent.comparison.varianceAmount)}
            detail={`Latest total minus current DD · ${int(sent.comparison.dollarComparableCount)} comparable`}
            tone="emerald"
            onOpen={() => setDrill({ cohort: "sent", scope: "dollar_comparable" })}
          />
          <MetricTile
            label="Percent variance"
            value={pct(sent.comparison.variancePercent)}
            detail={`Positive DD denominator · ${int(sent.comparison.percentageComparableCount)} comparable`}
            tone="emerald"
            onOpen={() => setDrill({ cohort: "sent", scope: "percent_comparable" })}
          />
          <MetricTile
            label="Blended margin"
            value={pct(sent.margin.blendedPercent)}
            detail={`Value-weighted · ${int(sent.margin.projectCount)} of ${int(sent.count)} usable`}
            tone="emerald"
            onOpen={() => setDrill({ cohort: "sent", scope: "margin_usable" })}
          />
        </div>
        <Coverage>
          Dollar variance compares {usd(sent.comparison.dollarComparableLatestBidBoardTotalSales)} latest total with {usd(sent.comparison.dollarComparableDdValue)} current DD across {int(sent.comparison.dollarComparableCount)} projects with both values; percentage variance uses {int(sent.comparison.percentageComparableCount)} with a positive DD. Margin is available on {int(sent.count - sent.missingMarginCount)} projects and weighted only where a positive latest total is also present.
        </Coverage>
        <div className="mt-3 overflow-hidden rounded-lg border border-slate-200">
          <ScrollSyncX bodyClassName="overflow-x-auto" bodyLabel="Projects sent to client">
            <table className="w-full min-w-[1050px] text-sm">
              <thead className="border-b border-slate-200 bg-emerald-50 text-left text-[10px] font-bold uppercase tracking-wide text-slate-500">
                <tr>
                  <SortableHeader label="Project" sortKey="name" sort={sentSort} className="px-3 py-2.5" />
                  <SortableHeader label="Project #" sortKey="reference" sort={sentSort} className="px-3 py-2.5" />
                  <SortableHeader label="First sent" sortKey="sent" sort={sentSort} className="px-3 py-2.5" />
                  <SortableHeader label="Current DD" sortKey="dd" sort={sentSort} numeric className="px-3 py-2.5 text-right" />
                  <SortableHeader label="Latest Bid Board total" sortKey="latest_total" sort={sentSort} numeric className="px-3 py-2.5 text-right" />
                  <SortableHeader label="Variance $" sortKey="variance_amount" sort={sentSort} numeric className="px-3 py-2.5 text-right" />
                  <SortableHeader label="Variance %" sortKey="variance_percent" sort={sentSort} numeric className="px-3 py-2.5 text-right" />
                  <SortableHeader label="Latest margin" sortKey="margin" sort={sentSort} numeric className="px-3 py-2.5 text-right" />
                </tr>
              </thead>
              <tbody>
                {sentSort.sortedRows.length === 0 ? (
                  <EmptyRows colSpan={8} label="No projects entered a sent-to-client stage in this activity period." />
                ) : (
                  sentSort.sortedRows.map((project) => (
                    <tr key={project.id} className="border-b border-slate-100 last:border-0 hover:bg-emerald-50/30">
                      <td className="px-3 py-2.5"><A1DealLink dealId={project.id}>{project.name}</A1DealLink></td>
                      <td className="px-3 py-2.5 font-mono text-xs text-slate-600">{reference(project.projectNumber, project.dealNumber)}</td>
                      <td className="px-3 py-2.5 tabular-nums text-slate-600">{formatCentralDay(project.sentAt)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">{usd(project.ddEstimate)}</td>
                      <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-slate-800">{usd(project.latestBidBoardTotalSales)}</td>
                      <td className={`px-3 py-2.5 text-right font-semibold tabular-nums ${project.varianceAmount != null && project.varianceAmount < 0 ? "text-rose-700" : "text-emerald-700"}`}>
                        {signedUsd(project.varianceAmount)}
                      </td>
                      <td className={`px-3 py-2.5 text-right font-semibold tabular-nums ${project.variancePercent != null && project.variancePercent < 0 ? "text-rose-700" : "text-emerald-700"}`}>
                        {pct(project.variancePercent)}
                      </td>
                      <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-slate-800">{pct(project.marginPercent)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </ScrollSyncX>
        </div>
      </section>

      <section aria-labelledby="rfp-sales-heading" className="rounded-xl border border-slate-200 bg-white p-4">
        <SectionHeading id="rfp-sales-heading" eyebrow={`Activity · ${periodName}`} title="RFPs by salesperson">
          <DrillPill label="All RFPs by salesperson" onOpen={() => setDrill({ cohort: "rfp", scope: "all" })} className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-700">
            {int(rfps.count)} RFPs · {usd(rfps.ddValue)} known DD
          </DrillPill>
        </SectionHeading>
        <Coverage>
          Grouped by <span className="font-semibold text-slate-700">current assigned sales rep</span>; later reassignment can move an earlier RFP request between rows.
        </Coverage>
        <div className="mt-3 overflow-hidden rounded-lg border border-slate-200">
          <ScrollSyncX bodyClassName="overflow-x-auto" bodyLabel="RFPs by current assigned salesperson">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-[10px] font-bold uppercase tracking-wide text-slate-500">
                <tr>
                  <SortableHeader label="Current assigned sales rep" sortKey="rep" sort={salespersonSort} className="px-3 py-2.5" />
                  <SortableHeader label="RFP count" sortKey="count" sort={salespersonSort} numeric className="px-3 py-2.5 text-right" />
                  <SortableHeader label="Known DD Estimate" sortKey="dd" sort={salespersonSort} numeric className="px-3 py-2.5 text-right" />
                  <SortableHeader label="Missing DD" sortKey="missing" sort={salespersonSort} numeric className="px-3 py-2.5 text-right" />
                </tr>
              </thead>
              <tbody>
                {salespersonSort.sortedRows.length === 0 ? (
                  <EmptyRows colSpan={4} label="No RFP request cycles were opened in this activity period." />
                ) : (
                  salespersonSort.sortedRows.map((row) => (
                    <tr key={row.repId ?? "unassigned"} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                      <td className="px-3 py-2.5 font-medium text-slate-800">{row.repName}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">
                        <button type="button" onClick={() => setDrill({ cohort: "rfp", scope: "rep_all", repId: row.repId, repName: row.repName })} aria-label={`Show ${row.repName} RFPs`} className="underline decoration-dotted underline-offset-4 hover:text-brand-red focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red">{int(row.count)}</button>
                      </td>
                      <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-slate-800">
                        <button type="button" onClick={() => setDrill({ cohort: "rfp", scope: "rep_known_dd", repId: row.repId, repName: row.repName })} aria-label={`Show ${row.repName} RFPs with known DD`} className="underline decoration-dotted underline-offset-4 hover:text-brand-red focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red">{usd(row.ddValue)}</button>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">
                        <button type="button" onClick={() => setDrill({ cohort: "rfp", scope: "rep_missing_dd", repId: row.repId, repName: row.repName })} aria-label={`Show ${row.repName} RFPs missing DD`} className="underline decoration-dotted underline-offset-4 hover:text-brand-red focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red">{int(row.missingDdCount)}</button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              {report.rfpBySalesperson.length > 0 ? (
                <tfoot className="border-t-2 border-slate-300 bg-slate-50 font-bold text-slate-800">
                  <tr>
                    <td className="px-3 py-2.5">All current assigned reps</td>
                    <td className="px-3 py-2.5 text-right tabular-nums"><button type="button" onClick={() => setDrill({ cohort: "rfp", scope: "all" })} aria-label="Show all RFPs" className="underline decoration-dotted underline-offset-4 hover:text-brand-red focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red">{int(rfps.count)}</button></td>
                    <td className="px-3 py-2.5 text-right tabular-nums"><button type="button" onClick={() => setDrill({ cohort: "rfp", scope: "known_dd" })} aria-label="Show all RFPs with known DD" className="underline decoration-dotted underline-offset-4 hover:text-brand-red focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red">{usd(rfps.ddValue)}</button></td>
                    <td className="px-3 py-2.5 text-right tabular-nums"><button type="button" onClick={() => setDrill({ cohort: "rfp", scope: "missing_dd" })} aria-label="Show all RFPs missing DD" className="underline decoration-dotted underline-offset-4 hover:text-brand-red focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red">{int(rfps.missingDdCount)}</button></td>
                  </tr>
                </tfoot>
              ) : null}
            </table>
          </ScrollSyncX>
        </div>
      </section>

      <EstimatingSupportingRecordsDialog request={drill} data={data} onClose={() => setDrill(null)} />
    </div>
  );
}
