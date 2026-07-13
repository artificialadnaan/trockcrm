import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import type { EstimatorAssignmentIssue } from "@trock-crm/shared/types";
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
import { ScrollSyncX } from "../scroll-sync-x";
import type { EstimatorDrillSelection } from "./types";

const PAGE_SIZE = 25;

const ISSUE_LABEL: Record<EstimatorAssignmentIssue, string> = {
  none: "Assigned",
  unassigned: "No assignment",
  unmapped_legacy: "Legacy name not linked",
  inactive_estimator: "Inactive estimator",
};

function formatCloseDate(value: string | null): string {
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

function EvidenceLoading() {
  return (
    <div role="status" className="grid gap-3 p-5" aria-label="Loading estimator project evidence">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="h-14 animate-pulse rounded-lg bg-slate-100" />
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

  return (
    <Sheet open={selection != null} onOpenChange={onOpenChange}>
      <SheetContent className="w-[96vw] gap-0 sm:max-w-6xl">
        <SheetHeader className="border-b border-slate-200 pr-14">
          <SheetTitle className="text-xl font-black text-slate-950">
            {selection?.title ?? "Estimator projects"}
          </SheetTitle>
          <SheetDescription>
            {selection?.description ?? "Projects matching this report segment."}
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
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
              <div className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-100 bg-slate-50 px-5 py-4">
                <div>
                  <p className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">
                    Matching projects
                  </p>
                  <p className="mt-1 text-2xl font-black tabular-nums text-slate-950">
                    {formatNumber(data.total.count)}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">
                    Best current estimate
                  </p>
                  <p className="mt-1 text-2xl font-black tabular-nums text-slate-950">
                    {formatUsd(data.total.value)}
                  </p>
                </div>
              </div>

              {data.records.length === 0 ? (
                <div className="m-5 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm font-semibold text-slate-500">
                  No projects match this assignment and stage.
                </div>
              ) : (
                <ScrollSyncX className="border-b border-slate-200" bodyClassName="overflow-x-auto">
                  <table className="min-w-[1180px] w-full border-collapse bg-white text-sm">
                    <caption className="sr-only">Projects in the selected estimator pipeline segment</caption>
                    <thead className="border-b border-slate-200 bg-slate-50">
                      <tr>
                        <th scope="col" className="px-4 py-3 text-left text-[11px] font-black uppercase tracking-[0.12em] text-slate-500">Project</th>
                        <th scope="col" className="px-3 py-3 text-left text-[11px] font-black uppercase tracking-[0.12em] text-slate-500">Owner</th>
                        <th scope="col" className="px-3 py-3 text-left text-[11px] font-black uppercase tracking-[0.12em] text-slate-500">Company / property</th>
                        <th scope="col" className="px-3 py-3 text-left text-[11px] font-black uppercase tracking-[0.12em] text-slate-500">Stage</th>
                        <th scope="col" className="px-3 py-3 text-right text-[11px] font-black uppercase tracking-[0.12em] text-slate-500">Days</th>
                        <th scope="col" className="px-3 py-3 text-right text-[11px] font-black uppercase tracking-[0.12em] text-slate-500">Value</th>
                        <th scope="col" className="px-3 py-3 text-left text-[11px] font-black uppercase tracking-[0.12em] text-slate-500">Close date</th>
                        <th scope="col" className="px-3 py-3 text-left text-[11px] font-black uppercase tracking-[0.12em] text-slate-500">Estimator</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.records.map((record) => {
                        const identifier = record.projectNumber ?? record.dealNumber;
                        return (
                          <tr key={record.dealId} className="border-b border-slate-100 align-top last:border-b-0 hover:bg-slate-50/70">
                            <td className="max-w-72 px-4 py-3">
                              <Link
                                to={{ pathname: `/deals/${record.dealId}`, search }}
                                className="font-bold text-slate-950 underline decoration-slate-300 underline-offset-2 hover:text-brand-red hover:decoration-brand-red focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red"
                              >
                                {record.dealName}
                              </Link>
                              <p className="mt-0.5 text-xs text-slate-500">{identifier ? `Project ${identifier}` : "No project number"}</p>
                            </td>
                            <td className="px-3 py-3 text-slate-700">{record.ownerName}</td>
                            <td className="max-w-64 px-3 py-3 text-slate-700">
                              <p className="font-semibold">{record.companyName ?? "No company"}</p>
                              <p className="mt-0.5 text-xs text-slate-500">{record.propertyName ?? "No property"}</p>
                            </td>
                            <td className="px-3 py-3 font-semibold text-slate-700">{record.stageLabel}</td>
                            <td className="px-3 py-3 text-right tabular-nums text-slate-700">{record.daysInStage ?? "N/A"}</td>
                            <td className="px-3 py-3 text-right font-bold tabular-nums text-slate-950">{formatUsd(record.pipelineValue)}</td>
                            <td className="px-3 py-3 text-slate-700">{formatCloseDate(record.expectedCloseDate)}</td>
                            <td className="max-w-60 px-3 py-3">
                              <p className="font-semibold text-slate-800">{record.estimatorName ?? ISSUE_LABEL[record.assignmentIssue]}</p>
                              {record.assignmentIssue !== "none" ? (
                                <p className="mt-0.5 text-xs font-semibold text-amber-700">
                                  {ISSUE_LABEL[record.assignmentIssue]}
                                  {record.assignmentIssue === "unmapped_legacy" && record.legacyEstimatorName
                                    ? `: ${record.legacyEstimatorName}`
                                    : ""}
                                </p>
                              ) : null}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </ScrollSyncX>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
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
