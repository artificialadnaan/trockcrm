import type { ReactNode } from "react";
import { ArrowDown, ArrowRight, ArrowUp, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ExportExcelButton } from "@/components/reports/export-excel-button";
import { PageHeader } from "@/components/layout/page-header";
import { ReportFilterBar } from "@/components/reports/report-filter-bar";
import type { ExcelSheet } from "@/lib/excel-export";
import { parseDisplayDate } from "@/lib/deal-utils";
export { sheetsFromReport } from "@/lib/excel-export";

export const CHART_COLORS = ["#cc0000", "#111827", "#2563eb", "#16a34a", "#f59e0b", "#7c3aed", "#0891b2", "#db2777"];

// Coerce to a finite number so a NaN/Infinity/null/undefined value (e.g. a 0/0
// percentage, or a missing aggregate) renders 0 instead of "$NaN" / "NaN%".
// `?? 0` is NOT enough — it passes NaN through; Number.isFinite catches it.
function finite(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function formatCurrency(value: number | null | undefined) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(finite(value));
}

export function formatNumber(value: number | null | undefined) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(finite(value));
}

export function formatPercent(value: number | null | undefined) {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(finite(value))}%`;
}

export function formatDate(value: string | null) {
  if (!value) return "No activity";
  // parseDisplayDate anchors a date-only "YYYY-MM-DD" to its literal calendar day
  // (#572), so a value like "2026-01-14" never renders "Jan 13" west of UTC the
  // way `new Date("2026-01-14")` (parsed as UTC midnight) would.
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(
    parseDisplayDate(value)
  );
}

export function ReportPageShell({
  title,
  description,
  loading,
  error,
  onRefresh,
  exportFilename,
  exportSheets = [],
  children,
}: {
  title: string;
  description: string;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  exportFilename?: string;
  exportSheets?: ExcelSheet[];
  children: ReactNode;
}) {
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Analytics" title={title} description={description} />
      <ReportFilterBar defaultRange="12m" />
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
        {exportFilename ? (
          <ExportExcelButton filename={exportFilename} sheets={exportSheets} disabled={loading} />
        ) : null}
      </div>
      {error ? (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="p-5 text-sm font-semibold text-red-700">{error}</CardContent>
        </Card>
      ) : null}
      {loading ? (
        <Card>
          <CardContent className="p-8 text-sm font-semibold text-slate-500">Loading report data...</CardContent>
        </Card>
      ) : children}
    </div>
  );
}

export function KpiCard({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <Card className="border-slate-200 bg-white">
      <CardContent className="p-5">
        <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">{label}</p>
        <div className="mt-2 text-2xl font-black tracking-tight text-slate-950">{value}</div>
        {accent ? <p className="mt-1 text-xs font-semibold text-slate-500">{accent}</p> : null}
      </CardContent>
    </Card>
  );
}

export function TrendIcon({ direction }: { direction: "up" | "down" | "flat" }) {
  if (direction === "up") return <ArrowUp className="h-4 w-4 text-emerald-600" />;
  if (direction === "down") return <ArrowDown className="h-4 w-4 text-brand-red" />;
  return <ArrowRight className="h-4 w-4 text-slate-500" />;
}

export function EmptyState({ label }: { label: string }) {
  return (
    <div className="grid min-h-44 place-items-center rounded-lg border border-dashed border-slate-200 bg-slate-50 text-sm font-semibold text-slate-500">
      {label}
    </div>
  );
}
