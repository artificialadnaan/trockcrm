import { Link } from "react-router-dom";
import type React from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { ExportExcelButton } from "@/components/reports/export-excel-button";
import { ReportFilterBar } from "@/components/reports/report-filter-bar";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ExcelSheet } from "@/lib/excel-export";
export { sheetsFromReport } from "@/lib/excel-export";

export const CHART_COLORS = ["#CC0000", "#0f172a", "#2563eb", "#059669", "#d97706", "#7c3aed"];

export function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value ?? 0);
}

export function formatPercent(value: number) {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value ?? 0)}%`;
}

export function formatInteger(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value ?? 0);
}

export function formatDate(value: string) {
  return new Date(`${value}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function ReportShell({
  eyebrow,
  title,
  description,
  loading,
  error,
  hasData,
  emptyText,
  onRefresh,
  exportFilename,
  exportSheets = [],
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  loading: boolean;
  error: string | null;
  hasData: boolean;
  emptyText: string;
  onRefresh: () => void;
  exportFilename?: string;
  exportSheets?: ExcelSheet[];
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader eyebrow={eyebrow} title={title} description={description} />
        <div className="flex gap-2">
          <Link
            to="/reports"
            className="inline-flex h-7 items-center justify-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 text-[0.8rem] font-medium text-slate-700 hover:bg-slate-50"
          >
            <ArrowLeft className="h-4 w-4" />
            Reports
          </Link>
          <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
          {exportFilename ? (
            <ExportExcelButton filename={exportFilename} sheets={exportSheets} disabled={loading || !hasData} />
          ) : null}
        </div>
      </div>
      <ReportFilterBar />
      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
          {error}
        </div>
      ) : null}
      {loading ? (
        <div className="rounded-lg border border-dashed border-slate-200 bg-white px-6 py-12 text-center text-sm font-semibold text-slate-500">
          Loading {title.toLowerCase()}...
        </div>
      ) : !hasData ? (
        <div className="rounded-lg border border-dashed border-slate-200 bg-white px-6 py-12 text-center text-sm font-semibold text-slate-500">
          {emptyText}
        </div>
      ) : children}
    </div>
  );
}

export function KpiStrip({ children }: { children: React.ReactNode }) {
  return <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{children}</section>;
}

export function KpiCard({ label, value, helper }: { label: string; value: string; helper: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">{label}</p>
      <p className="mt-3 text-3xl font-black tracking-tight text-slate-950">{value}</p>
      <p className="mt-1 text-xs font-semibold text-slate-500">{helper}</p>
    </div>
  );
}

export function Panel({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-5 py-4">
        <h2 className="text-lg font-black tracking-tight text-slate-950">{title}</h2>
        {description ? <p className="mt-1 text-sm text-slate-500">{description}</p> : null}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

export function DataTable({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-full overflow-x-auto">
      <Table className="min-w-[720px]">
        {children}
      </Table>
    </div>
  );
}

export { TableBody, TableCell, TableHead, TableHeader, TableRow };

/**
 * Keep the top-N rows by `yKey` and roll the remainder into a single "Other (k)" bucket. Pure so it can be
 * unit-tested. Used by the Revenue-by-Region chart: even after the server case-folds region spellings there
 * are ~46 regions, far too many for a legible bar chart, so the long tail collapses into one bar. The data
 * TABLE keeps the full normalized list, so the chart's bars + "Other" reconcile exactly to the table total.
 */
export function rollupTopN(
  data: Array<Record<string, unknown>>,
  xKey: string,
  yKey: string,
  topN: number,
  otherLabel = "Other",
): Array<Record<string, unknown>> {
  if (topN <= 0 || data.length <= topN) return data;
  const sorted = [...data].sort((a, b) => Number(b[yKey] ?? 0) - Number(a[yKey] ?? 0));
  const head = sorted.slice(0, topN);
  const tail = sorted.slice(topN);
  const otherTotal = tail.reduce((acc, row) => acc + Number(row[yKey] ?? 0), 0);
  return [...head, { [xKey]: `${otherLabel} (${tail.length})`, [yKey]: otherTotal }];
}

export function ValueBarChart({
  data,
  xKey,
  yKey,
  name,
  topN,
}: {
  data: Array<Record<string, unknown>>;
  xKey: string;
  yKey: string;
  name: string;
  /** When set, cap to the top-N rows by value and roll the rest into "Other"; also angles the x labels so
   *  every remaining category stays readable. Omit for charts with few categories (default behavior). */
  topN?: number;
}) {
  const chartData = topN ? rollupTopN(data, xKey, yKey, topN) : data;
  const dense = Boolean(topN);
  return (
    <div className={dense ? "h-96 w-full" : "h-80 w-full"}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} margin={{ top: 10, right: 20, left: 12, bottom: dense ? 80 : 20 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey={xKey}
            tick={{ fontSize: 12 }}
            interval={dense ? 0 : undefined}
            angle={dense ? -35 : undefined}
            textAnchor={dense ? "end" : undefined}
            height={dense ? 80 : undefined}
          />
          <YAxis tickFormatter={(value) => `$${Math.round(Number(value) / 1000)}k`} tick={{ fontSize: 12 }} />
          <Tooltip formatter={(value) => formatCurrency(Number(value))} />
          <Legend />
          <Bar dataKey={yKey} name={name} radius={[4, 4, 0, 0]}>
            {chartData.map((_, index) => <Cell key={index} fill={CHART_COLORS[index % CHART_COLORS.length]} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function CountBarChart({
  data,
  xKey,
  yKey,
  name,
}: {
  data: Array<Record<string, unknown>>;
  xKey: string;
  yKey: string;
  name: string;
}) {
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 10, right: 24, left: 24, bottom: 10 }}>
          <CartesianGrid strokeDasharray="3 3" horizontal={false} />
          <XAxis type="number" allowDecimals={false} tick={{ fontSize: 12 }} />
          <YAxis type="category" dataKey={xKey} width={92} tick={{ fontSize: 12 }} />
          <Tooltip />
          <Legend />
          <Bar dataKey={yKey} name={name} fill="#2563eb" radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function TrendChart({
  data,
  xKey,
  barKey,
  lineKey,
  barName,
  lineName,
  leftFormat = "number",
}: {
  data: Array<Record<string, unknown>>;
  xKey: string;
  barKey: string;
  lineKey?: string;
  barName: string;
  lineName?: string;
  // "currency" formats the left (barKey) axis + its tooltip as dollars ($Xk axis, $ tooltip), matching
  // ValueBarChart. Default "number" keeps the plain axis (e.g. lead-conversion's Leads count).
  leftFormat?: "currency" | "number";
}) {
  const isCurrency = leftFormat === "currency";
  return (
    <div className="h-80 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 10, right: 24, left: 12, bottom: 20 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey={xKey} tick={{ fontSize: 12 }} />
          <YAxis
            yAxisId="left"
            tick={{ fontSize: 12 }}
            tickFormatter={isCurrency ? (value) => `$${Math.round(Number(value) / 1000)}k` : undefined}
          />
          {lineKey ? <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 12 }} /> : null}
          <Tooltip
            formatter={
              isCurrency
                ? (value, name) => (name === barName ? formatCurrency(Number(value)) : value)
                : undefined
            }
          />
          <Legend />
          <Line yAxisId="left" type="monotone" dataKey={barKey} name={barName} stroke="#CC0000" strokeWidth={3} />
          {lineKey ? <Line yAxisId="right" type="monotone" dataKey={lineKey} name={lineName} stroke="#2563eb" strokeWidth={3} /> : null}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
