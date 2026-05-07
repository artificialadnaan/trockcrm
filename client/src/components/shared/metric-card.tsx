import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Eyebrow } from "./eyebrow";

export type MetricTone = "green" | "blue" | "white" | "red";
export type MetricAccent = "red" | "blue" | "green" | "amber" | "slate";

const badgeToneClasses: Record<Exclude<MetricTone, "red">, string> = {
  green: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
  blue: "bg-blue-50 text-blue-700 ring-1 ring-blue-200",
  white: "bg-white text-slate-700 ring-1 ring-slate-200",
};

const accentClasses: Record<MetricAccent, string> = {
  red: "bg-brand-red",
  blue: "bg-blue-400",
  green: "bg-emerald-400",
  amber: "bg-amber-400",
  slate: "bg-slate-500",
};

export function MetricCard({
  eyebrow,
  value,
  badge,
  caption,
  tone = "green",
  accent = "red",
  className,
}: {
  eyebrow: string;
  value: string;
  badge: string;
  caption: string;
  tone?: MetricTone;
  accent?: MetricAccent;
  className?: string;
}) {
  if (tone === "red") {
    return (
      <Card className={cn("relative overflow-hidden border-0 bg-brand-red text-white shadow-md", className)}>
        <CardContent className="p-5">
          <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-white/80">{eyebrow}</p>
          <p className="mt-2 text-4xl font-black leading-none text-white">{value}</p>
          <div className="mt-3 flex items-center gap-3">
            <span className="rounded-full bg-white/15 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ring-1 ring-white/20">
              {badge}
            </span>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-white/70">{caption}</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={cn("relative overflow-hidden border-slate-200 bg-white shadow-none", className)}>
      <CardContent className="p-5">
        <Eyebrow>{eyebrow}</Eyebrow>
        <p className="mt-2 text-4xl font-black leading-none text-slate-950">{value}</p>
        <div className="mt-3 flex items-center gap-3">
          <span className={cn("rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide", badgeToneClasses[tone])}>
            {badge}
          </span>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{caption}</p>
        </div>
      </CardContent>
      <div className={cn("absolute inset-x-0 bottom-0 h-1", accentClasses[accent])} aria-hidden />
    </Card>
  );
}
