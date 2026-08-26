import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useDealHref } from "@/hooks/use-office-scope";
import { formatDayShort, int, usd } from "../evidence-kit";
import { ScrollSyncX } from "../scroll-sync-x";
import type {
  CurrentEstimatingProject,
  EstimateSentProject,
  MondayShowcaseData,
  RfpInitiatedProject,
} from "./types";

type RfpGlobalDrillScope = "all" | "known_dd" | "missing_dd";
type RfpRepDrillScope = "rep_all" | "rep_known_dd" | "rep_missing_dd";
type SentDrillScope = "all" | "latest_total" | "dollar_comparable" | "percent_comparable" | "margin_usable";

export type A1DrillRequest =
  | { cohort: "current"; scope: "all" | "known_dd" | "missing_dd" }
  | { cohort: "rfp"; scope: RfpGlobalDrillScope }
  | { cohort: "rfp"; scope: RfpRepDrillScope; repId: string | null; repName: string }
  | { cohort: "sent"; scope: SentDrillScope };

interface ResolvedDrill {
  title: string;
  description: string;
  current?: CurrentEstimatingProject[];
  rfps?: RfpInitiatedProject[];
  sent?: EstimateSentProject[];
}

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

function projectNoun(count: number): string {
  return count === 1 ? "project" : "projects";
}

function knownDdSummary<T extends { ddEstimate: number | null }>(
  rows: readonly T[],
  publishedDdValue: number,
): string {
  const missing = rows.filter((row) => row.ddEstimate == null).length;
  return `${int(rows.length)} ${projectNoun(rows.length)} · ${usd(publishedDdValue)} known DD${missing ? ` · ${int(missing)} missing DD` : ""}`;
}

/** The sent-report tiles each have a distinct eligibility rule. Use the server-published aggregates — the
 * same rounded values rendered in the tile — while the dialog table supplies the exact supporting rows. */
function sentMetricSummary(
  scope: SentDrillScope,
  rows: readonly EstimateSentProject[],
  sent: MondayShowcaseData["estimatingReport"]["estimatesSent"],
): string {
  switch (scope) {
    case "all":
      return `${int(rows.length)} ${projectNoun(rows.length)} · ${usd(sent.latestBidBoardTotalSales)} latest Bid Board total${sent.missingSentValueCount ? ` · ${int(sent.missingSentValueCount)} missing latest total` : ""}`;
    case "latest_total":
      return `${int(rows.length)} ${projectNoun(rows.length)} · ${usd(sent.latestBidBoardTotalSales)} latest Bid Board total`;
    case "dollar_comparable":
      return `${int(rows.length)} ${projectNoun(rows.length)} · ${usd(sent.comparison.dollarComparableDdValue)} DD → ${usd(sent.comparison.dollarComparableLatestBidBoardTotalSales)} latest total · ${signedUsd(sent.comparison.varianceAmount)} variance`;
    case "percent_comparable":
      return `${int(rows.length)} ${projectNoun(rows.length)} · ${usd(sent.comparison.percentageComparableDdValue)} DD → ${usd(sent.comparison.percentageComparableLatestBidBoardTotalSales)} latest total · ${pct(sent.comparison.variancePercent)} variance`;
    case "margin_usable":
      return `${int(rows.length)} ${projectNoun(rows.length)} · ${usd(sent.margin.latestBidBoardTotalSales)} latest total · ${pct(sent.margin.blendedPercent)} weighted margin`;
  }
}

function routeScopeDescription(data: MondayShowcaseData): string {
  if (!data.routeFilter.active) return "";
  return ` Showing ${data.routeFilter.selected[0] === "service" ? "Service" : "Other"} only.`;
}

function isRepRfpDrill(request: A1DrillRequest): request is Extract<A1DrillRequest, { cohort: "rfp"; scope: RfpRepDrillScope }> {
  return request.cohort === "rfp" && request.scope.startsWith("rep_");
}

function resolveDrill(request: A1DrillRequest, data: MondayShowcaseData): ResolvedDrill {
  const report = data.estimatingReport;
  if (request.cohort === "current") {
    const rows = report.currentEstimating.projects.filter((project) =>
      request.scope === "all" ? true : request.scope === "known_dd" ? project.ddEstimate != null : project.ddEstimate == null
    );
    const title =
      request.scope === "all"
        ? "Current projects in Estimating"
        : request.scope === "known_dd"
          ? "Current Estimating — known DD"
          : "Current Estimating — missing DD";
    return {
      title,
      description: `${knownDdSummary(rows, request.scope === "missing_dd" ? 0 : report.currentEstimating.ddValue)} · live current workload as of ${formatCentralTimestamp(report.currentAsOf)}.${routeScopeDescription(data)}`,
      current: rows,
    };
  }

  if (request.cohort === "rfp") {
    const repRows = isRepRfpDrill(request)
      ? report.newRfps.projects.filter((project) => project.assignedRepId === request.repId)
      : report.newRfps.projects;
    const scope = request.scope;
    const rows = repRows.filter((project) =>
      scope === "all" || scope === "rep_all"
        ? true
        : scope === "known_dd" || scope === "rep_known_dd"
          ? project.ddEstimate != null
          : project.ddEstimate == null
    );
    const qualifier =
      scope === "known_dd" || scope === "rep_known_dd"
        ? " — known DD"
        : scope === "missing_dd" || scope === "rep_missing_dd"
          ? " — missing DD"
          : "";
    const owner = isRepRfpDrill(request) ? `${request.repName} — ` : "";
    const publishedDdValue =
      scope === "missing_dd" || scope === "rep_missing_dd"
        ? 0
        : isRepRfpDrill(request)
          ? report.rfpBySalesperson.find((row) => row.repId === request.repId)?.ddValue ?? 0
          : report.newRfps.ddValue;
    return {
      title: `${owner}RFP submissions initiated${qualifier}`,
      description: `${knownDdSummary(rows, publishedDdValue)} · current RFP-request cycle in ${data.period.label}.${routeScopeDescription(data)}`,
      rfps: rows,
    };
  }

  const allSent = report.estimatesSent.projects;
  const rows = allSent.filter((project) => {
    switch (request.scope) {
      case "all":
        return true;
      case "latest_total":
        return project.latestBidBoardTotalSales != null;
      case "dollar_comparable":
        return project.ddEstimate != null && project.latestBidBoardTotalSales != null;
      case "percent_comparable":
        return project.ddEstimate != null && project.ddEstimate > 0 && project.latestBidBoardTotalSales != null;
      case "margin_usable":
        return project.latestBidBoardTotalSales != null && project.latestBidBoardTotalSales > 0 && project.marginPercent != null;
    }
  });
  const titleByScope = {
    all: "Projects sent to client",
    latest_total: "Projects sent — latest Bid Board total",
    dollar_comparable: "Projects sent — DD / latest-total comparison",
    percent_comparable: "Projects sent — percentage comparison",
    margin_usable: "Projects sent — blended margin base",
  } as const;
  return {
    title: titleByScope[request.scope],
    description: `${sentMetricSummary(request.scope, rows, report.estimatesSent)} · first sent in ${data.period.label}. Financial values are latest Bid Board / CRM values, not immutable send-time snapshots.${routeScopeDescription(data)}`,
    sent: rows,
  };
}

/** Native, scoped deal link shared by the A1 page and its supporting-record dialog. */
export function A1DealLink({ dealId, children, className }: { dealId: string; children: ReactNode; className?: string }) {
  const dealHref = useDealHref();
  return (
    <a
      href={dealHref(dealId)}
      target="_blank"
      rel="noopener noreferrer"
      className={className ?? "font-medium text-slate-800 underline decoration-slate-300 underline-offset-2 hover:text-brand-red hover:decoration-brand-red focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red"}
    >
      {children}
    </a>
  );
}

function EmptyRows({ colSpan }: { colSpan: number }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-8 text-center text-sm text-slate-500">
        No projects support this figure.
      </td>
    </tr>
  );
}

function CurrentRows({ rows }: { rows: readonly CurrentEstimatingProject[] }) {
  return (
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
        {rows.length === 0 ? <EmptyRows colSpan={5} /> : rows.map((project) => (
          <tr key={project.id} className="border-b border-slate-100 last:border-0 hover:bg-violet-50/30">
            <td className="px-3 py-2.5"><A1DealLink dealId={project.id}>{project.name}</A1DealLink></td>
            <td className="px-3 py-2.5 font-mono text-xs text-slate-600">{reference(project.projectNumber, project.dealNumber)}</td>
            <td className="px-3 py-2.5 text-slate-600">{project.stageLabel}</td>
            <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-slate-800">{usd(project.ddEstimate)}</td>
            <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">{project.daysInStage == null ? "—" : `${int(project.daysInStage)}d`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RfpRows({ rows }: { rows: readonly RfpInitiatedProject[] }) {
  return (
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
        {rows.length === 0 ? <EmptyRows colSpan={6} /> : rows.map((project) => (
          <tr key={project.id} className="border-b border-slate-100 last:border-0 hover:bg-sky-50/30">
            <td className="px-3 py-2.5"><A1DealLink dealId={project.id}>{project.name}</A1DealLink></td>
            <td className="px-3 py-2.5 font-mono text-xs text-slate-600">{reference(project.projectNumber, project.dealNumber)}</td>
            <td className="px-3 py-2.5 tabular-nums text-slate-600">{formatCentralDay(project.requestedAt)}</td>
            <td className="px-3 py-2.5 text-slate-600">{project.currentRfpStatus ?? "—"}</td>
            <td className="px-3 py-2.5 text-slate-600">{project.assignedRepName}</td>
            <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-slate-800">{usd(project.ddEstimate)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SentRows({ rows }: { rows: readonly EstimateSentProject[] }) {
  return (
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
        {rows.length === 0 ? <EmptyRows colSpan={8} /> : rows.map((project) => (
          <tr key={project.id} className="border-b border-slate-100 last:border-0 hover:bg-emerald-50/30">
            <td className="px-3 py-2.5"><A1DealLink dealId={project.id}>{project.name}</A1DealLink></td>
            <td className="px-3 py-2.5 font-mono text-xs text-slate-600">{reference(project.projectNumber, project.dealNumber)}</td>
            <td className="px-3 py-2.5 tabular-nums text-slate-600">{formatCentralDay(project.sentAt)}</td>
            <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">{usd(project.ddEstimate)}</td>
            <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-slate-800">{usd(project.latestBidBoardTotalSales)}</td>
            <td className={`px-3 py-2.5 text-right font-semibold tabular-nums ${project.varianceAmount != null && project.varianceAmount < 0 ? "text-rose-700" : "text-emerald-700"}`}>{signedUsd(project.varianceAmount)}</td>
            <td className={`px-3 py-2.5 text-right font-semibold tabular-nums ${project.variancePercent != null && project.variancePercent < 0 ? "text-rose-700" : "text-emerald-700"}`}>{pct(project.variancePercent)}</td>
            <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-slate-800">{pct(project.marginPercent)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function EstimatingSupportingRecordsDialog({
  request,
  data,
  onClose,
}: {
  request: A1DrillRequest | null;
  data: MondayShowcaseData;
  onClose: () => void;
}) {
  const payloadKey = `${data.period.from}|${data.period.to}|${data.period.mode}|${data.estimatingReport.currentAsOf}|${data.routeFilter.selected.join(",")}`;
  const previousPayloadKey = useRef(payloadKey);
  useEffect(() => {
    if (previousPayloadKey.current !== payloadKey) {
      previousPayloadKey.current = payloadKey;
      if (request != null) onClose();
    }
  }, [onClose, payloadKey, request]);

  const resolved = useMemo(() => (request == null ? null : resolveDrill(request, data)), [data, request]);
  return (
    <Dialog open={request != null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="flex max-h-[85vh] w-[min(96vw,1120px)] flex-col gap-3 sm:max-w-[min(96vw,1120px)]">
        <DialogHeader className="pr-8">
          <DialogTitle>{resolved?.title ?? "Supporting records"}</DialogTitle>
          <DialogDescription>{resolved?.description ?? ""}</DialogDescription>
        </DialogHeader>
        {resolved ? (
          <div className="flex min-h-0 flex-col gap-2">
            <ScrollSyncX className="min-h-0 rounded-lg border border-slate-200" bodyClassName="max-h-[55vh] overflow-auto" bodyLabel={`${resolved.title} supporting records`}>
              {resolved.current ? <CurrentRows rows={resolved.current} /> : resolved.rfps ? <RfpRows rows={resolved.rfps} /> : <SentRows rows={resolved.sent ?? []} />}
            </ScrollSyncX>
            <p className="px-1 text-xs text-slate-500">Click a project name to open that deal in a new tab.</p>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
