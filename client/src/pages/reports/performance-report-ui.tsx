import { Link } from "react-router-dom";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatDealDisplayName } from "@/lib/deal-utils";
import { useDealHref } from "@/hooks/use-office-scope";

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

/**
 * A report headline number, optionally usable as a filter.
 *
 * Interactivity is OPT-IN via `onClick`, and it is all-or-nothing on purpose. Without a handler the
 * card renders exactly as it always has: a plain div, no pointer cursor, no hover, and — the part that
 * matters — no tab stop, so a card that cannot meaningfully filter (a distinct-count like "Days With
 * Activity") never advertises an affordance it does not have. With a handler it becomes a real
 * <button>, so Enter and Space work for free, `aria-pressed` announces the toggle state, and the
 * active state is carried by colour and a ring rather than by a cursor a keyboard user never sees.
 *
 * Every consumer that passes only label/value/helper is unchanged by this.
 */
export function KpiCard({
  label,
  value,
  helper,
  onClick,
  active = false,
  actionHint,
}: {
  label: string;
  value: string;
  helper?: string;
  /** Provide to make the card a toggle filter. Omit for a static, non-focusable card. */
  onClick?: () => void;
  /** Whether this card's filter is currently applied. Ignored when `onClick` is absent. */
  active?: boolean;
  /** Overrides the default affordance line. Useful for a card whose "on" state is the cleared state. */
  actionHint?: { idle: string; active: string };
}) {
  const body = (
    <>
      <p
        className={cn(
          "text-[11px] font-black uppercase tracking-[0.18em]",
          active && onClick ? "text-brand-red" : "text-slate-500"
        )}
      >
        {label}
      </p>
      <p className="mt-3 text-2xl font-black tracking-tight text-slate-950">{value}</p>
      {helper ? <p className="mt-1 text-xs font-semibold text-slate-500">{helper}</p> : null}
    </>
  );

  if (!onClick) {
    return (
      <Card className="border-slate-200 bg-white">
        <CardContent className="p-4">{body}</CardContent>
      </Card>
    );
  }

  const hint = actionHint ?? { idle: "Click to filter the log", active: "Filtering the log · click to clear" };
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        // Matches the static card's shape (rounded-xl, white, ring-as-border) so an interactive card
        // sits in the same grid without looking like a different component.
        "flex cursor-pointer flex-col rounded-xl bg-white p-4 text-left transition",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2",
        active
          ? "bg-brand-red/5 ring-2 ring-brand-red"
          : "ring-1 ring-foreground/10 hover:bg-brand-red/[0.03] hover:ring-brand-red/40"
      )}
    >
      {body}
      <span
        className={cn(
          "mt-2 text-[10px] font-black uppercase tracking-[0.12em]",
          active ? "text-brand-red" : "text-slate-400"
        )}
      >
        {active ? hint.active : hint.idle}
      </span>
    </button>
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

// Takes the deal NAME and its FLAG, rather than reformatting whatever child it is handed.
//
// It used to accept `children: ReactNode` and rewrite any string child through the formatter. That is a
// syntax-fallback GENERATOR: the relabel is applied invisibly, at every call site at once, with nowhere
// to put the one input that decides it correctly — so an ordinary deal a human named
// "Lobby — Change Order 1" was relabelled in every report that routed through here, and adding a caller
// silently opted it in too. `dealIsChangeOrder` is REQUIRED (not optional) on purpose: tsc now refuses a
// caller that has not answered the question, which is the only way this stays closed as callers are added.
// A CO child is STORED "<Parent> — Change Order N" and truncates to look like its parent; this is
// display-only — exports and the stored name are untouched.
export function DealLink({
  dealId,
  dealName,
  dealIsChangeOrder,
}: {
  dealId: string;
  dealName: string;
  dealIsChangeOrder: boolean | null | undefined;
}) {
  // Carries ?officeId when the URL has one. Without it a row read under a cross-office scope links
  // into the viewer's default schema and 404s — see useDealHref for why ?office must NOT be used here.
  const dealHref = useDealHref();
  return <Link className="font-bold text-slate-950 underline decoration-brand-red/40 underline-offset-4 hover:text-brand-red" to={dealHref(dealId)}>{formatDealDisplayName(dealName, dealIsChangeOrder)}</Link>;
}
