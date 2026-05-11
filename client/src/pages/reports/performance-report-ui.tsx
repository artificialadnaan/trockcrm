import { Link } from "react-router-dom";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

export function formatCurrency(value: number | null | undefined) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(Number(value ?? 0));
}

export function formatNumber(value: number | null | undefined) {
  return new Intl.NumberFormat("en-US").format(Number(value ?? 0));
}

export function formatPercent(value: number | null | undefined) {
  return `${Number(value ?? 0).toFixed(1)}%`;
}

export function formatDate(value: string | null | undefined) {
  if (!value) return "No activity";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

export function KpiCard({ label, value, helper }: { label: string; value: string; helper?: string }) {
  return (
    <Card className="border-slate-200 bg-white">
      <CardContent className="p-4">
        <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">{label}</p>
        <p className="mt-3 text-2xl font-black tracking-tight text-slate-950">{value}</p>
        {helper ? <p className="mt-1 text-xs font-semibold text-slate-500">{helper}</p> : null}
      </CardContent>
    </Card>
  );
}

export function ReportPanel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-lg font-black tracking-tight text-slate-950">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function LoadingState({ label = "Loading report..." }: { label?: string }) {
  return (
    <div className="flex min-h-40 items-center justify-center rounded-lg border border-slate-200 bg-white text-sm font-semibold text-slate-500">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      {label}
    </div>
  );
}

export function EmptyState({ label = "No report data for this filter set." }: { label?: string }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm font-semibold text-slate-500">
      {label}
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-700">
      <AlertTriangle className="h-4 w-4" />
      {message}
    </div>
  );
}

export function DealLink({ dealId, children }: { dealId: string; children: React.ReactNode }) {
  return <Link className="font-bold text-slate-950 underline decoration-brand-red/40 underline-offset-4 hover:text-brand-red" to={`/deals/${dealId}`}>{children}</Link>;
}
