import { useMemo, useState } from "react";
import { Download, RefreshCw, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  buildPrintableReportHtml,
  buildReportExportFilename,
  downloadTextFile,
  openPrintableReportWindow,
  serializeRowsToCsv,
} from "@/lib/report-export";
import {
  type ForecastVarianceOverview,
  useForecastVarianceOverview,
} from "@/hooks/use-reports";

function getDefaultDateRange() {
  const year = new Date().getFullYear();
  const today = new Date().toISOString().slice(0, 10);
  return {
    from: `${year}-01-01`,
    to: today,
  };
}

function formatCurrency(value: number | null) {
  if (value === null) return "--";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDays(value: number | null) {
  if (value === null) return "--";
  return `${value}d`;
}

function buildForecastExportRows(data: ForecastVarianceOverview) {
  return data.deals.map((row) => ({
    Deal: row.dealName,
    Rep: row.repName,
    Workflow: row.workflowRoute,
    "Initial Forecast": row.initialForecast,
    "Qualified Forecast": row.qualifiedForecast,
    "Estimating Forecast": row.estimatingForecast,
    "Awarded Amount": row.awardedAmount,
    "Initial Variance": row.initialVariance,
    "Qualified Variance": row.qualifiedVariance,
    "Estimating Variance": row.estimatingVariance,
    "Close Drift Days": row.closeDriftDays,
  }));
}

function SummaryCard({
  label,
  value,
  helper,
}: {
  label: string;
  value: string;
  helper: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-400">{label}</p>
      <div className="mt-3 flex items-end justify-between gap-3">
        <p className="text-3xl font-black tracking-tight text-slate-900">{value}</p>
        <span className="rounded-full bg-white px-2 py-1 text-[11px] font-semibold text-slate-500">
          {helper}
        </span>
      </div>
    </div>
  );
}

export function ForecastVarianceSection() {
  const defaults = useMemo(() => getDefaultDateRange(), []);
  const [filters, setFilters] = useState({
    from: defaults.from,
    to: defaults.to,
    officeId: "",
    regionId: "",
    repId: "",
    source: "",
  });

  const query = useMemo(
    () => ({
      from: filters.from || undefined,
      to: filters.to || undefined,
      officeId: filters.officeId.trim() || undefined,
      regionId: filters.regionId.trim() || undefined,
      repId: filters.repId.trim() || undefined,
      source: filters.source.trim() || undefined,
    }),
    [filters.from, filters.to, filters.officeId, filters.regionId, filters.repId, filters.source]
  );

  const { data, loading, error, refetch } = useForecastVarianceOverview(query);
  const summary = data?.summary;

  function handleExportCsv() {
    if (!data) return;
    downloadTextFile(
      serializeRowsToCsv(buildForecastExportRows(data)),
      buildReportExportFilename("forecast-variance", "csv"),
      "text/csv;charset=utf-8;"
    );
  }

  function handleExportPdf() {
    if (!data) return;
    const printableHtml = buildPrintableReportHtml({
      reportName: "Forecast Variance",
      rows: buildForecastExportRows(data),
      generatedAtLabel: new Date().toLocaleString("en-US"),
      metadata: [
        { label: "From", value: filters.from },
        { label: "To", value: filters.to },
        { label: "Office ID", value: filters.officeId || "All" },
        { label: "Region ID", value: filters.regionId || "All" },
        { label: "Rep ID", value: filters.repId || "All" },
        { label: "Source", value: filters.source || "All" },
      ],
    });
    openPrintableReportWindow(printableHtml);
  }

  return (
    <section className="rounded-3xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="border-b border-slate-100 px-6 py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#CC0000] mb-2">
              Pipeline Accuracy
            </p>
            <h2 className="text-2xl font-black tracking-tight text-slate-900">
              Forecast Variance
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Compare the original, qualified, and estimating-stage forecast against final awarded value.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="border-slate-200 text-slate-600"
              onClick={() => void refetch()}
              disabled={loading}
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="border-slate-200 text-slate-600"
              onClick={handleExportCsv}
              disabled={loading || !data || data.deals.length === 0}
            >
              <Download className="h-4 w-4 mr-2" />
              Export CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="border-slate-200 text-slate-600"
              onClick={handleExportPdf}
              disabled={loading || !data || data.deals.length === 0}
            >
              <Download className="h-4 w-4 mr-2" />
              Export PDF
            </Button>
          </div>
        </div>
      </div>

      <div className="border-b border-slate-100 bg-slate-50 px-6 py-4">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-6 gap-3">
          <Input
            type="date"
            value={filters.from}
            onChange={(event) => setFilters((current) => ({ ...current, from: event.target.value }))}
            className="h-9"
            aria-label="Forecast from date"
          />
          <Input
            type="date"
            value={filters.to}
            onChange={(event) => setFilters((current) => ({ ...current, to: event.target.value }))}
            className="h-9"
            aria-label="Forecast to date"
          />
          <Input
            value={filters.officeId}
            onChange={(event) => setFilters((current) => ({ ...current, officeId: event.target.value }))}
            placeholder="Office ID"
            className="h-9"
          />
          <Input
            value={filters.regionId}
            onChange={(event) => setFilters((current) => ({ ...current, regionId: event.target.value }))}
            placeholder="Region ID"
            className="h-9"
          />
          <Input
            value={filters.repId}
            onChange={(event) => setFilters((current) => ({ ...current, repId: event.target.value }))}
            placeholder="Rep ID"
            className="h-9"
          />
          <Input
            value={filters.source}
            onChange={(event) => setFilters((current) => ({ ...current, source: event.target.value }))}
            placeholder="Source"
            className="h-9"
          />
        </div>
      </div>

      <div className="px-6 py-6 space-y-6">
        {error && (
          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {loading ? (
          <div className="rounded-2xl border border-dashed border-slate-200 px-6 py-12 text-center text-sm text-slate-400">
            Loading forecast variance...
          </div>
        ) : !data ? (
          <div className="rounded-2xl border border-dashed border-slate-200 px-6 py-12 text-center text-sm text-slate-400">
            No forecast variance data found for the selected filters.
          </div>
        ) : (
          <>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
              <SummaryCard
                label="Comparable Deals"
                value={summary ? String(summary.comparableDeals) : "0"}
                helper="closed-won"
              />
              <SummaryCard
                label="Avg Initial Variance"
                value={formatCurrency(summary?.avgInitialVariance ?? 0)}
                helper="first forecast"
              />
              <SummaryCard
                label="Avg Qualified Variance"
                value={formatCurrency(summary?.avgQualifiedVariance ?? 0)}
                helper="dd stage"
              />
              <SummaryCard
                label="Avg Estimating Variance"
                value={formatCurrency(summary?.avgEstimatingVariance ?? 0)}
                helper="estimating stage"
              />
              <SummaryCard
                label="Avg Close Drift"
                value={formatDays(summary?.avgCloseDriftDays ?? 0)}
                helper="expected close"
              />
            </div>

            <div className="grid gap-4 xl:grid-cols-[0.95fr,1.05fr]">
              <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
                <div className="border-b border-slate-100 px-5 py-4">
                  <div className="flex items-center gap-2">
                    <TrendingUp className="h-4 w-4 text-[#CC0000]" />
                    <h3 className="text-base font-bold text-slate-900">Variance by Rep</h3>
                  </div>
                  <p className="text-xs text-slate-400">Average forecast drift by rep across comparable deals.</p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-slate-100 text-left text-xs font-semibold uppercase tracking-wider text-slate-400">
                        <th className="px-4 py-3">Rep</th>
                        <th className="px-4 py-3 text-right">Deals</th>
                        <th className="px-4 py-3 text-right">Initial</th>
                        <th className="px-4 py-3 text-right">Qualified</th>
                        <th className="px-4 py-3 text-right">Estimating</th>
                      </tr>
                    </thead>
                    <tbody className="text-sm text-slate-700">
                      {data.repRollups.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="px-4 py-8 text-center text-sm text-slate-400">
                            No rep rollups available.
                          </td>
                        </tr>
                      ) : (
                        data.repRollups.map((row) => (
                          <tr key={row.repId} className="border-b border-slate-50 last:border-b-0">
                            <td className="px-4 py-4 font-medium text-slate-900">{row.repName}</td>
                            <td className="px-4 py-4 text-right tabular-nums">{row.comparableDeals}</td>
                            <td className="px-4 py-4 text-right tabular-nums">{formatCurrency(row.avgInitialVariance)}</td>
                            <td className="px-4 py-4 text-right tabular-nums">{formatCurrency(row.avgQualifiedVariance)}</td>
                            <td className="px-4 py-4 text-right tabular-nums">{formatCurrency(row.avgEstimatingVariance)}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
                <div className="border-b border-slate-100 px-5 py-4">
                  <h3 className="text-base font-bold text-slate-900">Highest Variance Deals</h3>
                  <p className="text-xs text-slate-400">The individual deals with the largest forecast drift.</p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-slate-100 text-left text-xs font-semibold uppercase tracking-wider text-slate-400">
                        <th className="px-4 py-3">Deal</th>
                        <th className="px-4 py-3">Rep</th>
                        <th className="px-4 py-3 text-right">Initial</th>
                        <th className="px-4 py-3 text-right">Awarded</th>
                        <th className="px-4 py-3 text-right">Variance</th>
                      </tr>
                    </thead>
                    <tbody className="text-sm text-slate-700">
                      {data.deals.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="px-4 py-8 text-center text-sm text-slate-400">
                            No deal-level variance rows available.
                          </td>
                        </tr>
                      ) : (
                        data.deals.map((row) => (
                          <tr key={row.dealId} className="border-b border-slate-50 last:border-b-0">
                            <td className="px-4 py-4">
                              <div className="font-medium text-slate-900">{row.dealName}</div>
                              <div className="text-xs uppercase tracking-wide text-slate-400">{row.workflowRoute}</div>
                            </td>
                            <td className="px-4 py-4">{row.repName}</td>
                            <td className="px-4 py-4 text-right tabular-nums">{formatCurrency(row.initialForecast)}</td>
                            <td className="px-4 py-4 text-right tabular-nums">{formatCurrency(row.awardedAmount)}</td>
                            <td className="px-4 py-4 text-right tabular-nums font-semibold text-[#CC0000]">
                              {formatCurrency(row.initialVariance)}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
