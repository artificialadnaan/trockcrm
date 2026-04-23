import {
  buildPrintableReportHtml,
  buildReportExportFilename,
  downloadTextFile,
  serializeRowsToCsv,
  openPrintableReportWindow,
} from "@/lib/report-export";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PipelineBarChart } from "@/components/charts/pipeline-bar-chart";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  RegionalOwnershipOverview,
} from "@/hooks/use-reports";

function formatCurrency(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toLocaleString()}`;
}

function getGapLabel(gapType: RegionalOwnershipOverview["ownershipGaps"][number]["gapType"]) {
  return gapType === "missing_assigned_rep" ? "Missing Assigned Rep" : "Missing Region";
}

function getExportRows(data: RegionalOwnershipOverview) {
  return [
    ...data.regionRollups.map((row) => ({
      section: "Region",
      name: row.regionName,
      dealCount: row.dealCount,
      activityCount: null,
      pipelineValue: row.pipelineValue,
      staleDealCount: row.staleDealCount,
      gapType: null,
      gapCount: null,
    })),
    ...data.repRollups.map((row) => ({
      section: "Rep",
      name: row.repName,
      dealCount: row.dealCount,
      activityCount: row.activityCount,
      pipelineValue: row.pipelineValue,
      staleDealCount: row.staleDealCount,
      gapType: null,
      gapCount: null,
    })),
    ...data.ownershipGaps.map((gap) => ({
      section: "Ownership Gap",
      name: getGapLabel(gap.gapType),
      dealCount: null,
      activityCount: null,
      pipelineValue: null,
      staleDealCount: null,
      gapType: gap.gapType,
      gapCount: gap.count,
    })),
  ];
}

export function RegionalOwnershipSection({
  data,
  loading,
  error,
}: {
  data: RegionalOwnershipOverview | null;
  loading: boolean;
  error?: string | null;
}) {
  const regionChartData = data?.regionRollups.map((row) => ({
    stageName: row.regionName,
    stageColor: null,
    dealCount: row.dealCount,
    totalValue: row.pipelineValue,
  })) ?? [];

  function handleExportCsv() {
    if (!data) return;
    const rows = getExportRows(data);
    downloadTextFile(
      serializeRowsToCsv(rows),
      buildReportExportFilename("regional-ownership", "csv"),
      "text/csv;charset=utf-8;",
    );
  }

  function handleExportPdf() {
    if (!data) return;
    const rows = getExportRows(data);
    const generatedAtLabel = new Date().toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    const printableHtml = buildPrintableReportHtml({
      reportName: "Regional and Rep Ownership",
      rows,
      generatedAtLabel,
      metadata: [
        { label: "Scope", value: "Current office only" },
        { label: "Export", value: "Regional pipeline, rep rollups, and ownership gaps" },
      ],
    });
    openPrintableReportWindow(printableHtml);
  }

  return (
    <section className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#CC0000] mb-2">
            Office Scope
          </p>
          <h2 className="text-2xl font-black tracking-tight text-slate-900">
            Regional and Rep Ownership
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-slate-500">
            Current-office ownership rollups by region and rep, with diagnostics for gaps that need review.
          </p>
        </div>
        <div className="flex flex-col items-end gap-3">
          {data && (
            <div className="grid grid-cols-3 gap-3 text-right">
              <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
                <p className="text-[11px] uppercase tracking-wider text-slate-400">Regions</p>
                <p className="mt-1 text-xl font-black text-slate-900">{data.regionRollups.length}</p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
                <p className="text-[11px] uppercase tracking-wider text-slate-400">Reps</p>
                <p className="mt-1 text-xl font-black text-slate-900">{data.repRollups.length}</p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
                <p className="text-[11px] uppercase tracking-wider text-slate-400">Gaps</p>
                <p className="mt-1 text-xl font-black text-slate-900">{data.ownershipGaps.reduce((sum, gap) => sum + gap.count, 0)}</p>
              </div>
            </div>
          )}
          {data && (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" className="border-slate-200 text-slate-600" onClick={handleExportCsv}>
                Export CSV
              </Button>
              <Button variant="outline" size="sm" className="border-slate-200 text-slate-600" onClick={handleExportPdf}>
                Export PDF
              </Button>
            </div>
          )}
        </div>
      </div>

      {loading ? (
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-sm font-medium text-slate-500">Loading regional ownership…</p>
          <div className="h-4 w-56 rounded bg-slate-100 animate-pulse" />
          <div className="mt-4 space-y-3">
            <div className="h-10 rounded bg-slate-100 animate-pulse" />
            <div className="h-10 rounded bg-slate-100 animate-pulse" />
            <div className="h-10 rounded bg-slate-100 animate-pulse" />
          </div>
        </div>
      ) : error ? (
        <div className="rounded-3xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700">
          {error}
        </div>
      ) : !data ? (
        <div className="rounded-3xl border border-dashed border-slate-200 bg-white px-5 py-10 text-center text-sm text-slate-400 shadow-sm">
          No regional ownership data found for the selected filters.
        </div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-3xl border border-slate-200 bg-white shadow-sm overflow-hidden">
            <div className="px-6 py-5 border-b border-slate-100">
              <h3 className="text-sm font-bold text-slate-900">Regional Pipeline by Region</h3>
              <p className="text-xs text-slate-400 mt-0.5">Office-scoped pipeline value by region.</p>
            </div>
            <div className="p-4">
              {regionChartData.length === 0 ? (
                <div className="py-12 text-center text-sm text-slate-400">No region chart data available.</div>
              ) : (
                <PipelineBarChart data={regionChartData} />
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div className="rounded-3xl border border-slate-200 bg-white shadow-sm overflow-hidden">
              <div className="px-6 py-5 border-b border-slate-100">
                <h3 className="text-sm font-bold text-slate-900">By Region</h3>
                <p className="text-xs text-slate-400 mt-0.5">Pipeline and stale deal view by region.</p>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Region</TableHead>
                    <TableHead className="text-right">Deals</TableHead>
                    <TableHead className="text-right">Pipeline</TableHead>
                    <TableHead className="text-right">Stale</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.regionRollups.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="py-8 text-center text-sm text-slate-400">
                        No region rollups available.
                      </TableCell>
                    </TableRow>
                  ) : (
                    data.regionRollups.map((row) => (
                      <TableRow key={`${row.regionId ?? "unassigned"}-${row.regionName}`}>
                        <TableCell className="font-medium text-slate-900">{row.regionName}</TableCell>
                        <TableCell className="text-right tabular-nums">{row.dealCount.toLocaleString()}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatCurrency(row.pipelineValue)}</TableCell>
                        <TableCell className="text-right tabular-nums">{row.staleDealCount.toLocaleString()}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white shadow-sm overflow-hidden">
              <div className="px-6 py-5 border-b border-slate-100">
                <h3 className="text-sm font-bold text-slate-900">By Rep</h3>
                <p className="text-xs text-slate-400 mt-0.5">Owned pipeline, activity, and stale deal counts.</p>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Rep</TableHead>
                    <TableHead className="text-right">Deals</TableHead>
                    <TableHead className="text-right">Activity</TableHead>
                    <TableHead className="text-right">Pipeline</TableHead>
                    <TableHead className="text-right">Stale</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.repRollups.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="py-8 text-center text-sm text-slate-400">
                        No rep rollups available.
                      </TableCell>
                    </TableRow>
                  ) : (
                    data.repRollups.map((row) => (
                      <TableRow key={row.repId}>
                        <TableCell className="font-medium text-slate-900">{row.repName}</TableCell>
                        <TableCell className="text-right tabular-nums">{row.dealCount.toLocaleString()}</TableCell>
                        <TableCell className="text-right tabular-nums">{row.activityCount.toLocaleString()}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatCurrency(row.pipelineValue)}</TableCell>
                        <TableCell className="text-right tabular-nums">{row.staleDealCount.toLocaleString()}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white shadow-sm overflow-hidden">
            <div className="px-6 py-5 border-b border-slate-100">
              <h3 className="text-sm font-bold text-slate-900">Ownership Gaps</h3>
              <p className="text-xs text-slate-400 mt-0.5">Diagnostics kept separate from broader data-mining views.</p>
            </div>
            <div className="p-6 flex flex-wrap gap-3">
              {data.ownershipGaps.length === 0 ? (
                <div className="text-sm text-slate-400">No ownership gaps found.</div>
              ) : (
                data.ownershipGaps.map((gap) => (
                  <Badge key={gap.gapType} variant="secondary" className="px-3 py-1.5 text-xs">
                    {getGapLabel(gap.gapType)} · {gap.count}
                  </Badge>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
