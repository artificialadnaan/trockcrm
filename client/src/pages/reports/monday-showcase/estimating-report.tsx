import type { ReactNode } from "react";
import { formatDayShort, int, usd } from "../evidence-kit";
import { ScrollSyncX } from "../scroll-sync-x";
import { WEEK_MODE_LABELS } from "../week-mode";
import type { MondayShowcaseData } from "./types";

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

function MetricTile({ label, value, detail, tone = "slate" }: { label: string; value: string; detail: string; tone?: "slate" | "violet" | "sky" | "emerald" }) {
  const colors = {
    slate: "border-slate-200 bg-white text-slate-900",
    violet: "border-violet-200 bg-violet-50/70 text-violet-900",
    sky: "border-sky-200 bg-sky-50/70 text-sky-900",
    emerald: "border-emerald-200 bg-emerald-50/70 text-emerald-900",
  } as const;
  return (
    <div className={`rounded-xl border p-3 ${colors[tone]}`}>
      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-black tabular-nums">{value}</p>
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
          />
          <MetricTile
            label="New RFPs initiated"
            value={`${int(rfps.count)} projects`}
            detail={`${usd(rfps.ddValue)} known DD · ${rfps.count - rfps.missingDdCount} of ${rfps.count} present`}
            tone="sky"
          />
          <MetricTile
            label="Projects sent"
            value={`${int(sent.count)} projects`}
            detail={`${usd(sent.latestBidBoardTotalSales)} latest Bid Board total`}
            tone="emerald"
          />
          <MetricTile
            label="Blended margin"
            value={pct(sent.margin.blendedPercent)}
            detail={`Weighted across ${sent.margin.projectCount} of ${sent.count} sent projects`}
          />
        </div>
      </div>

      <section aria-labelledby="current-estimating-heading" className="rounded-xl border border-violet-200 bg-white p-4">
        <SectionHeading id="current-estimating-heading" eyebrow="Live workload" title="Current projects in Estimating">
          <span className="rounded-full bg-violet-100 px-2.5 py-1 text-[11px] font-semibold text-violet-800">
            {int(current.count)} projects · {usd(current.ddValue)} known DD
          </span>
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
                  <th className="px-3 py-2.5">Project</th>
                  <th className="px-3 py-2.5">Project #</th>
                  <th className="px-3 py-2.5">Current stage</th>
                  <th className="px-3 py-2.5 text-right">DD Estimate</th>
                  <th className="px-3 py-2.5 text-right">Time in stage</th>
                </tr>
              </thead>
              <tbody>
                {current.projects.length === 0 ? (
                  <EmptyRows colSpan={5} label="No current projects are in Estimating for this department selection." />
                ) : (
                  current.projects.map((project) => (
                    <tr key={project.id} className="border-b border-slate-100 last:border-0 hover:bg-violet-50/30">
                      <td className="px-3 py-2.5 font-medium text-slate-800">{project.name}</td>
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
          <span className="rounded-full bg-sky-100 px-2.5 py-1 text-[11px] font-semibold text-sky-800">
            {int(rfps.count)} projects · {usd(rfps.ddValue)} known DD
          </span>
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
                  <th className="px-3 py-2.5">Project</th>
                  <th className="px-3 py-2.5">Project #</th>
                  <th className="px-3 py-2.5">Request opened</th>
                  <th className="px-3 py-2.5">Current RFP status</th>
                  <th className="px-3 py-2.5">Current assigned sales rep</th>
                  <th className="px-3 py-2.5 text-right">DD Estimate</th>
                </tr>
              </thead>
              <tbody>
                {rfps.projects.length === 0 ? (
                  <EmptyRows colSpan={6} label="No RFP request cycles were opened in this activity period." />
                ) : (
                  rfps.projects.map((project) => (
                    <tr key={project.id} className="border-b border-slate-100 last:border-0 hover:bg-sky-50/30">
                      <td className="px-3 py-2.5 font-medium text-slate-800">{project.name}</td>
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
          <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-[11px] font-semibold text-emerald-800">
            {int(sent.count)} projects · {usd(sent.latestBidBoardTotalSales)} latest total
          </span>
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
          />
          <MetricTile
            label="Comparable Current DD Estimate"
            value={usd(sent.comparison.dollarComparableDdValue)}
            detail={`Same ${int(sent.comparison.dollarComparableCount)}-project base as $ variance`}
            tone="emerald"
          />
          <MetricTile
            label="Dollar variance"
            value={signedUsd(sent.comparison.varianceAmount)}
            detail={`Latest total minus current DD · ${int(sent.comparison.dollarComparableCount)} comparable`}
            tone="emerald"
          />
          <MetricTile
            label="Percent variance"
            value={pct(sent.comparison.variancePercent)}
            detail={`Positive DD denominator · ${int(sent.comparison.percentageComparableCount)} comparable`}
            tone="emerald"
          />
          <MetricTile
            label="Blended margin"
            value={pct(sent.margin.blendedPercent)}
            detail={`Value-weighted · ${int(sent.margin.projectCount)} of ${int(sent.count)} usable`}
            tone="emerald"
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
                  <th className="px-3 py-2.5">Project</th>
                  <th className="px-3 py-2.5">Project #</th>
                  <th className="px-3 py-2.5">First sent</th>
                  <th className="px-3 py-2.5 text-right">Current DD</th>
                  <th className="px-3 py-2.5 text-right">Latest Bid Board total</th>
                  <th className="px-3 py-2.5 text-right">Variance $</th>
                  <th className="px-3 py-2.5 text-right">Variance %</th>
                  <th className="px-3 py-2.5 text-right">Latest margin</th>
                </tr>
              </thead>
              <tbody>
                {sent.projects.length === 0 ? (
                  <EmptyRows colSpan={8} label="No projects entered a sent-to-client stage in this activity period." />
                ) : (
                  sent.projects.map((project) => (
                    <tr key={project.id} className="border-b border-slate-100 last:border-0 hover:bg-emerald-50/30">
                      <td className="px-3 py-2.5 font-medium text-slate-800">{project.name}</td>
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
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-700">
            {int(rfps.count)} RFPs · {usd(rfps.ddValue)} known DD
          </span>
        </SectionHeading>
        <Coverage>
          Grouped by <span className="font-semibold text-slate-700">current assigned sales rep</span>; later reassignment can move an earlier RFP request between rows.
        </Coverage>
        <div className="mt-3 overflow-hidden rounded-lg border border-slate-200">
          <ScrollSyncX bodyClassName="overflow-x-auto" bodyLabel="RFPs by current assigned salesperson">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-[10px] font-bold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2.5">Current assigned sales rep</th>
                  <th className="px-3 py-2.5 text-right">RFP count</th>
                  <th className="px-3 py-2.5 text-right">Known DD Estimate</th>
                  <th className="px-3 py-2.5 text-right">Missing DD</th>
                </tr>
              </thead>
              <tbody>
                {report.rfpBySalesperson.length === 0 ? (
                  <EmptyRows colSpan={4} label="No RFP request cycles were opened in this activity period." />
                ) : (
                  report.rfpBySalesperson.map((row) => (
                    <tr key={row.repId ?? "unassigned"} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                      <td className="px-3 py-2.5 font-medium text-slate-800">{row.repName}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">{int(row.count)}</td>
                      <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-slate-800">{usd(row.ddValue)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">{int(row.missingDdCount)}</td>
                    </tr>
                  ))
                )}
              </tbody>
              {report.rfpBySalesperson.length > 0 ? (
                <tfoot className="border-t-2 border-slate-300 bg-slate-50 font-bold text-slate-800">
                  <tr>
                    <td className="px-3 py-2.5">All current assigned reps</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{int(rfps.count)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{usd(rfps.ddValue)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{int(rfps.missingDdCount)}</td>
                  </tr>
                </tfoot>
              ) : null}
            </table>
          </ScrollSyncX>
        </div>
      </section>
    </div>
  );
}
