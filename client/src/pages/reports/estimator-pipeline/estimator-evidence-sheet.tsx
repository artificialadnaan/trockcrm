import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import type {
  EstimatorAssignmentIssue,
  EstimatorPipelineCohort,
  EstimatorPipelineEvidenceRecord,
} from "@trock-crm/shared/types";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useEstimatorPipelineEvidence } from "@/hooks/use-estimator-pipeline-report";
import { formatNumber, formatUsd } from "../operations-report-common";
import type { EstimatorDrillSelection } from "./types";

const PAGE_SIZE = 25;

const ISSUE_LABEL: Record<EstimatorAssignmentIssue, string> = {
  none: "Assigned",
  unassigned: "No assignment",
  unmapped_legacy: "Legacy name not linked",
  inactive_estimator: "Inactive estimator",
};

function formatDate(value: string | null): string {
  if (!value) return "No date";
  const date = new Date(`${value.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function dateLabel(cohort: EstimatorPipelineCohort): string {
  return cohort === "won" ? "Won date" : "Expected close";
}

function recordDate(record: EstimatorPipelineEvidenceRecord, cohort: EstimatorPipelineCohort): string {
  return formatDate(cohort === "won" ? record.wonClosedDate : record.expectedCloseDate);
}

function stageBadgeClass(stageSlug: string): string {
  if (stageSlug === "won") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (stageSlug === "estimating" || stageSlug === "service_estimating") {
    return "border-sky-200 bg-sky-50 text-sky-800";
  }
  if (["estimate_under_review", "estimate_sent_to_client", "contract"].includes(stageSlug)) {
    return "border-amber-200 bg-amber-50 text-amber-900";
  }
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function issueBadgeClass(issue: EstimatorAssignmentIssue): string {
  if (issue === "none") return "border-slate-200 bg-slate-50 text-slate-700";
  if (issue === "inactive_estimator") return "border-red-200 bg-red-50 text-red-800";
  return "border-amber-200 bg-amber-50 text-amber-900";
}

function estimatorLabel(record: EstimatorPipelineEvidenceRecord): string {
  if (record.estimatorName) return record.estimatorName;
  if (record.assignmentIssue === "unmapped_legacy" && record.legacyEstimatorName) {
    return record.legacyEstimatorName;
  }
  return ISSUE_LABEL[record.assignmentIssue];
}

function EvidenceLoading() {
  return (
    <div role="status" className="grid gap-3 p-5" aria-label="Loading estimator project evidence">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="h-24 animate-pulse rounded-lg bg-slate-100" />
      ))}
    </div>
  );
}

function ProjectLink({
  record,
  search,
  heading = false,
}: {
  record: EstimatorPipelineEvidenceRecord;
  search: string;
  heading?: boolean;
}) {
  const identifier = record.projectNumber ?? record.dealNumber;
  const link = (
    <Link
      to={{ pathname: `/deals/${record.dealId}`, search }}
      className="break-words font-black leading-5 text-slate-950 underline decoration-slate-300 underline-offset-2 hover:text-brand-red hover:decoration-brand-red focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red"
    >
      {record.dealName}
    </Link>
  );
  return (
    <div className="min-w-0">
      {heading ? <h3>{link}</h3> : link}
      <p className="mt-1 break-words text-xs font-semibold text-slate-500">
        {identifier ? `Project ${identifier}` : "No project number"}
      </p>
      <p className="mt-2 break-words text-xs leading-5 text-slate-600">
        <span className="font-bold text-slate-700">{record.companyName ?? "No company"}</span>
        <span className="block">{record.propertyName ?? "No property"}</span>
      </p>
    </div>
  );
}

function AssignmentDetails({ record }: { record: EstimatorPipelineEvidenceRecord }) {
  return (
    <div className="min-w-0 space-y-2">
      <div>
        <p className="text-[11px] font-black uppercase tracking-[0.08em] text-slate-500">Owner</p>
        <p className="mt-0.5 break-words font-semibold text-slate-800">{record.ownerName}</p>
      </div>
      <div>
        <p className="text-[11px] font-black uppercase tracking-[0.08em] text-slate-500">Estimator</p>
        <p className="mt-0.5 break-words font-semibold text-slate-800">{estimatorLabel(record)}</p>
        {record.assignmentIssue !== "none" ? (
          <span className={`mt-1 inline-flex max-w-full rounded-md border px-2 py-1 text-[11px] font-bold leading-4 ${issueBadgeClass(record.assignmentIssue)}`}>
            {ISSUE_LABEL[record.assignmentIssue]}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function DesktopEvidenceTable({
  records,
  cohort,
  valueLabel,
  search,
}: {
  records: EstimatorPipelineEvidenceRecord[];
  cohort: EstimatorPipelineCohort;
  valueLabel: string;
  search: string;
}) {
  return (
    <div className="hidden lg:block" data-testid="estimator-evidence-table">
      <table className="w-full table-fixed border-collapse bg-white text-sm">
        <caption className="sr-only">Projects in the selected estimator report segment</caption>
        <colgroup>
          <col className="w-[31%]" />
          <col className="w-[23%]" />
          <col className="w-[17%]" />
          <col className="w-[14%]" />
          <col className="w-[15%]" />
        </colgroup>
        <thead className="border-b border-slate-200 bg-slate-100/80">
          <tr>
            <th scope="col" className="px-5 py-3 text-left text-[11px] font-black uppercase tracking-[0.1em] text-slate-600">Project and customer</th>
            <th scope="col" className="px-4 py-3 text-left text-[11px] font-black uppercase tracking-[0.1em] text-slate-600">Assignment</th>
            <th scope="col" className="px-4 py-3 text-left text-[11px] font-black uppercase tracking-[0.1em] text-slate-600">Stage</th>
            <th scope="col" className="px-4 py-3 text-left text-[11px] font-black uppercase tracking-[0.1em] text-slate-600">{dateLabel(cohort)}</th>
            <th scope="col" className="px-5 py-3 text-right text-[11px] font-black uppercase tracking-[0.1em] text-slate-600">{valueLabel}</th>
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <tr key={record.dealId} className="border-b border-slate-100 align-top last:border-b-0 hover:bg-slate-50/80">
              <td className="min-w-0 px-5 py-4"><ProjectLink record={record} search={search} /></td>
              <td className="min-w-0 px-4 py-4"><AssignmentDetails record={record} /></td>
              <td className="min-w-0 px-4 py-4">
                <span className={`inline-flex max-w-full rounded-md border px-2 py-1 text-xs font-bold leading-4 ${stageBadgeClass(record.stageSlug)}`}>
                  {record.stageLabel}
                </span>
                <p className="mt-2 text-xs font-semibold text-slate-600">
                  {record.daysInStage == null ? "Stage age unavailable" : `${formatNumber(record.daysInStage)} days in stage`}
                </p>
              </td>
              <td className="min-w-0 px-4 py-4 font-semibold text-slate-700">{recordDate(record, cohort)}</td>
              <td className="min-w-0 px-5 py-4 text-right font-black tabular-nums text-slate-950">{formatUsd(record.pipelineValue)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MobileEvidenceCards({
  records,
  cohort,
  valueLabel,
  search,
}: {
  records: EstimatorPipelineEvidenceRecord[];
  cohort: EstimatorPipelineCohort;
  valueLabel: string;
  search: string;
}) {
  return (
    <div className="grid gap-3 p-4 lg:hidden" data-testid="estimator-evidence-cards">
      {records.map((record) => (
        <article key={record.dealId} className="min-w-0 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex min-w-0 flex-col items-start justify-between gap-3 sm:flex-row">
            <div className="min-w-0 flex-1"><ProjectLink record={record} search={search} heading /></div>
            <div className="flex w-full items-baseline justify-between gap-3 border-t border-slate-100 pt-3 sm:block sm:w-auto sm:shrink-0 sm:border-t-0 sm:pt-0 sm:text-right">
              <p className="text-[10px] font-black uppercase tracking-[0.08em] text-slate-500">{valueLabel}</p>
              <p className="mt-1 font-black tabular-nums text-slate-950">{formatUsd(record.pipelineValue)}</p>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
            <span className={`inline-flex rounded-md border px-2 py-1 text-xs font-bold ${stageBadgeClass(record.stageSlug)}`}>
              {record.stageLabel}
            </span>
            <span className="text-xs font-semibold text-slate-600">
              {record.daysInStage == null ? "Stage age unavailable" : `${formatNumber(record.daysInStage)} days in stage`}
            </span>
          </div>

          <dl className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-[11px] font-black uppercase tracking-[0.08em] text-slate-500">Owner</dt>
              <dd className="mt-1 break-words font-semibold text-slate-800">{record.ownerName}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-[11px] font-black uppercase tracking-[0.08em] text-slate-500">Estimator</dt>
              <dd className="mt-1 break-words font-semibold text-slate-800">{estimatorLabel(record)}</dd>
              {record.assignmentIssue !== "none" ? (
                <span className={`mt-1 inline-flex rounded-md border px-2 py-1 text-[11px] font-bold ${issueBadgeClass(record.assignmentIssue)}`}>
                  {ISSUE_LABEL[record.assignmentIssue]}
                </span>
              ) : null}
            </div>
            <div className="min-w-0">
              <dt className="text-[11px] font-black uppercase tracking-[0.08em] text-slate-500">{dateLabel(cohort)}</dt>
              <dd className="mt-1 font-semibold text-slate-800">{recordDate(record, cohort)}</dd>
            </div>
          </dl>
        </article>
      ))}
    </div>
  );
}

export function EstimatorEvidenceSheet({
  selection,
  officeScopeKey,
  onOpenChange,
}: {
  selection: EstimatorDrillSelection | null;
  officeScopeKey?: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { search } = useLocation();
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [selection, officeScopeKey]);

  const request = useMemo(
    () => selection
      ? {
          cohort: selection.cohort,
          asOf: selection.cohort === "won" ? selection.period.to : undefined,
          bucket: selection.bucket,
          estimatorKey: selection.estimatorKey,
          stageSlug: selection.stageSlug,
          page,
          pageSize: PAGE_SIZE,
        }
      : null,
    [page, selection],
  );
  const { data, loading, error, refetch } = useEstimatorPipelineEvidence(request, officeScopeKey);
  const cohort = data?.filter.cohort ?? selection?.cohort ?? "open";

  return (
    <Sheet open={selection != null} onOpenChange={onOpenChange}>
      <SheetContent className="gap-0 overflow-hidden border-t-4 border-t-brand-red data-[side=right]:w-[96vw] data-[side=right]:max-w-none data-[side=right]:sm:w-[min(94vw,90rem)] data-[side=right]:sm:max-w-none [&_[data-slot=sheet-close]]:size-11 [&_[data-slot=sheet-close]]:rounded-lg [&_[data-slot=sheet-close]]:border [&_[data-slot=sheet-close]]:border-slate-300 [&_[data-slot=sheet-close]]:bg-white [&_[data-slot=sheet-close]]:shadow-sm">
        <SheetHeader className="border-b border-slate-200 bg-white px-5 py-4 pr-16">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-md border px-2 py-1 text-[11px] font-black uppercase tracking-[0.08em] ${cohort === "won" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-sky-200 bg-sky-50 text-sky-800"}`}>
              {cohort === "won" ? "Won YTD" : "Open pipeline"}
            </span>
            {data?.filter.stageLabel ? (
              <span className={`rounded-md border px-2 py-1 text-[11px] font-bold ${stageBadgeClass(data.filter.stageSlug ?? "")}`}>
                {data.filter.stageLabel}
              </span>
            ) : null}
          </div>
          <SheetTitle className="mt-2 text-2xl font-black tracking-tight text-slate-950">
            {selection?.title ?? "Estimator projects"}
          </SheetTitle>
          <SheetDescription className="max-w-3xl leading-5 text-slate-600">
            {selection?.description ?? "Projects matching this report segment."}
          </SheetDescription>
        </SheetHeader>

        <div
          className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto bg-slate-50/50"
          data-testid="estimator-evidence-scroller"
        >
          {loading ? <EvidenceLoading /> : null}

          {!loading && error ? (
            <div role="alert" className="m-5 rounded-lg border border-red-200 bg-red-50 p-5 text-sm text-red-800">
              <p className="font-bold">Project evidence could not be loaded.</p>
              <p className="mt-1">{error}</p>
              <Button type="button" variant="outline" className="mt-4" onClick={refetch}>
                Try again
              </Button>
            </div>
          ) : null}

          {!loading && !error && data ? (
            <>
              <section className="grid border-b border-slate-200 bg-white sm:grid-cols-[1fr_1fr_auto]" aria-label="Selected project totals">
                <div className="border-b border-slate-100 px-5 py-4 sm:border-b-0 sm:border-r">
                  <p className="text-[11px] font-black uppercase tracking-[0.1em] text-slate-500">Matching projects</p>
                  <p className="mt-1 text-2xl font-black tabular-nums text-slate-950">{formatNumber(data.total.count)}</p>
                </div>
                <div className={`border-b px-5 py-4 sm:border-b-0 sm:border-r ${cohort === "won" ? "border-emerald-100 bg-emerald-50/55" : "border-sky-100 bg-sky-50/55"}`}>
                  <p className={`text-[11px] font-black uppercase tracking-[0.1em] ${cohort === "won" ? "text-emerald-800" : "text-sky-800"}`}>
                    {data.filter.valueBasisLabel}
                  </p>
                  <p className="mt-1 text-2xl font-black tabular-nums text-slate-950">{formatUsd(data.total.value)}</p>
                </div>
                <div className="min-w-48 px-5 py-4">
                  <p className="text-[11px] font-black uppercase tracking-[0.1em] text-slate-500">Cohort</p>
                  <p className="mt-1 text-sm font-black text-slate-900">
                    {data.filter.period?.label ?? "Current open pipeline"}
                  </p>
                  {data.filter.period ? (
                    <p className="mt-0.5 text-xs font-semibold text-slate-500">
                      {formatDate(data.filter.period.from)} to {formatDate(data.filter.period.to)}
                    </p>
                  ) : null}
                </div>
              </section>

              {data.records.length === 0 ? (
                <div className="m-5 rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center text-sm font-semibold text-slate-600">
                  No projects match this assignment and stage.
                </div>
              ) : (
                <div className="overflow-hidden border-b border-slate-200 bg-white">
                  <DesktopEvidenceTable
                    records={data.records}
                    cohort={cohort}
                    valueLabel={data.filter.valueBasisLabel}
                    search={search}
                  />
                  <MobileEvidenceCards
                    records={data.records}
                    cohort={cohort}
                    valueLabel={data.filter.valueBasisLabel}
                    search={search}
                  />
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3 bg-white px-5 py-4">
                <p className="text-sm font-medium text-slate-600">
                  Page {formatNumber(data.pagination.page)} of {formatNumber(data.pagination.totalPages)}
                </p>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={data.pagination.page <= 1}
                    onClick={() => setPage(Math.max(1, data.pagination.page - 1))}
                    aria-label="Show previous project evidence page"
                  >
                    Previous
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={data.pagination.page >= data.pagination.totalPages}
                    onClick={() => setPage(data.pagination.page + 1)}
                    aria-label="Show next project evidence page"
                  >
                    Next
                  </Button>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
