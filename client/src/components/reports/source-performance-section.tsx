import { useMemo, useState, type ReactNode } from "react";
import {
  BarChart,
  Bar,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Download, RefreshCw, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLeadSourceROI, type LeadSourceRoiRow } from "@/hooks/use-reports";
import {
  buildPrintableReportHtml,
  buildReportExportFilename,
  downloadTextFile,
  openPrintableReportWindow,
  serializeRowsToCsv,
} from "@/lib/report-export";
import { getChartColor } from "@/components/charts/chart-colors";

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function getDefaultDateRange() {
  const year = new Date().getFullYear();
  const today = new Date().toISOString().slice(0, 10);
  return {
    from: `${year}-01-01`,
    to: today,
  };
}

function formatPercent(value: number) {
  return `${value}%`;
}

function renderChartValue(value: number) {
  return value.toLocaleString();
}

function buildSourcePerformanceExportRows(rows: LeadSourceRoiRow[]) {
  return rows.map((row) => ({
    Source: row.source,
    "Lead Count": row.leadCount,
    "Deal Count": row.dealCount,
    "Active Deals": row.activeDeals,
    "Won Deals": row.wonDeals,
    "Lost Deals": row.lostDeals,
    "Active Pipeline Value": row.activePipelineValue,
    "Won Value": row.wonValue,
    "Win Rate": row.winRate,
  }));
}

export function SourcePerformanceSection() {
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

  const { data, loading, error, refetch } = useLeadSourceROI(query);
  const rows = data ?? [];

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, row) => {
          acc.leads += row.leadCount;
          acc.deals += row.dealCount;
          acc.activeDeals += row.activeDeals;
          acc.wonValue += row.wonValue;
          acc.pipelineValue += row.activePipelineValue;
          return acc;
        },
        { leads: 0, deals: 0, activeDeals: 0, wonValue: 0, pipelineValue: 0 }
      ),
    [rows]
  );

  const topRow = rows[0];
  const chartData = rows.map((row) => ({
    source: row.source,
    leadCount: row.leadCount,
    dealCount: row.dealCount,
  }));
  const exportRows = buildSourcePerformanceExportRows(rows);

  function handleExportCsv() {
    const csv = serializeRowsToCsv(exportRows);
    downloadTextFile(csv, buildReportExportFilename("Source Performance", "csv"), "text/csv;charset=utf-8;");
  }

  function handleExportPdf() {
    const printableHtml = buildPrintableReportHtml({
      reportName: "Source Performance",
      rows: exportRows,
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
              Canonical Report
            </p>
            <h2 className="text-2xl font-black tracking-tight text-slate-900">
              Source Performance
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Lead-source ROI with lead counts, deal counts, and filtered office / region / rep scope.
            </p>
          </div>
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
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="border-slate-200 text-slate-600"
              onClick={handleExportCsv}
              disabled={loading || rows.length === 0}
            >
              <Download className="h-4 w-4 mr-2" />
              Export CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="border-slate-200 text-slate-600"
              onClick={handleExportPdf}
              disabled={loading || rows.length === 0}
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
            onChange={(e) => setFilters((current) => ({ ...current, from: e.target.value }))}
            className="h-9"
            aria-label="From date"
          />
          <Input
            type="date"
            value={filters.to}
            onChange={(e) => setFilters((current) => ({ ...current, to: e.target.value }))}
            className="h-9"
            aria-label="To date"
          />
          <Input
            value={filters.officeId}
            onChange={(e) => setFilters((current) => ({ ...current, officeId: e.target.value }))}
            placeholder="Office ID"
            className="h-9"
          />
          <Input
            value={filters.regionId}
            onChange={(e) => setFilters((current) => ({ ...current, regionId: e.target.value }))}
            placeholder="Region ID"
            className="h-9"
          />
          <Input
            value={filters.repId}
            onChange={(e) => setFilters((current) => ({ ...current, repId: e.target.value }))}
            placeholder="Rep ID"
            className="h-9"
          />
          <Input
            value={filters.source}
            onChange={(e) => setFilters((current) => ({ ...current, source: e.target.value }))}
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
            Loading source performance...
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-200 px-6 py-12 text-center text-sm text-slate-400">
            No source performance data found for the selected filters.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
              <MetricCard label="Lead Count" value={totals.leads.toLocaleString()} />
              <MetricCard label="Deal Count" value={totals.deals.toLocaleString()} />
              <MetricCard label="Won Value" value={formatCurrency(totals.wonValue)} />
              <MetricCard label="Active Pipeline" value={formatCurrency(totals.pipelineValue)} />
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="mb-4">
                <h3 className="text-sm font-bold text-slate-900">Lead and Deal Volume by Source</h3>
                <p className="mt-1 text-xs text-slate-500">
                  Comparison of lead count versus deal count for each source in the selected scope.
                </p>
              </div>
              <div className="h-[320px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis
                      dataKey="source"
                      tick={{ fontSize: 12, fill: "#64748b" }}
                      axisLine={{ stroke: "#e2e8f0" }}
                    />
                    <YAxis
                      tick={{ fontSize: 12, fill: "#64748b" }}
                      axisLine={{ stroke: "#e2e8f0" }}
                      tickFormatter={renderChartValue}
                    />
                    <Tooltip
                      formatter={(value: number, name: string) => [
                        renderChartValue(value),
                        name === "leadCount" ? "Lead Count" : "Deal Count",
                      ]}
                      contentStyle={{ fontSize: 12, borderRadius: 8 }}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="leadCount" name="Lead Count" fill={getChartColor(0)} radius={[4, 4, 0, 0]}>
                      {chartData.map((entry, index) => (
                        <Cell key={entry.source} fill={getChartColor(index)} />
                      ))}
                    </Bar>
                    <Bar dataKey="dealCount" name="Deal Count" fill={getChartColor(1)} radius={[4, 4, 0, 0]}>
                      {chartData.map((entry, index) => (
                        <Cell key={entry.source} fill={getChartColor(index + 1)} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="overflow-x-auto rounded-2xl border border-slate-200">
              <table className="w-full text-sm">
                <thead className="bg-slate-50">
                  <tr className="border-b border-slate-200">
                    <Th>Source</Th>
                    <Th align="right">Lead Count</Th>
                    <Th align="right">Deal Count</Th>
                    <Th align="right">Active Deals</Th>
                    <Th align="right">Won Deals</Th>
                    <Th align="right">Win Rate</Th>
                    <Th align="right">Active Pipeline</Th>
                    <Th align="right">Won Value</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.source} className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50">
                      <Td>{row.source}</Td>
                      <Td align="right">{row.leadCount.toLocaleString()}</Td>
                      <Td align="right">{row.dealCount.toLocaleString()}</Td>
                      <Td align="right">{row.activeDeals.toLocaleString()}</Td>
                      <Td align="right">{row.wonDeals.toLocaleString()}</Td>
                      <Td align="right">{formatPercent(row.winRate)}</Td>
                      <Td align="right">{formatCurrency(row.activePipelineValue)}</Td>
                      <Td align="right">{formatCurrency(row.wonValue)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {topRow && (
              <div className="rounded-2xl border border-slate-100 bg-slate-50 px-5 py-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                  <TrendingUp className="h-4 w-4 text-[#CC0000]" />
                  Top source: {topRow.source}
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  {topRow.leadCount.toLocaleString()} leads, {topRow.dealCount.toLocaleString()} deals, {formatCurrency(topRow.wonValue)} won value.
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4 shadow-sm">
      <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-400">{label}</div>
      <div className="mt-2 text-2xl font-black tracking-tight text-slate-900">{value}</div>
    </div>
  );
}

function Th({ children, align = "left" }: { children: ReactNode; align?: "left" | "right" }) {
  return (
    <th className={`px-4 py-3 text-[11px] font-bold uppercase tracking-[0.18em] text-slate-400 ${align === "right" ? "text-right" : "text-left"}`}>
      {children}
    </th>
  );
}

function Td({ children, align = "left" }: { children: ReactNode; align?: "left" | "right" }) {
  return (
    <td className={`px-4 py-4 text-sm text-slate-700 ${align === "right" ? "text-right tabular-nums" : ""}`}>
      {children}
    </td>
  );
}
